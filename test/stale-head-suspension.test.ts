/**
 * §2.2 stale-head suspension (FINDING-14 family; ruling by Mica
 * 2026-08-18): a stale-head decline parks the exact bid revision instead
 * of returning it to arbitration. The measured counterfactual: an
 * engaged, polite, permanently-stale bidder churned offer/decline every
 * six seconds for ~100 cycles, invisible to lapse (declines are
 * engagement), to degradation telemetry (streaks count expiries), and to
 * fairness (nothing charges a decline). Every mechanism locally truthful;
 * composite: silent livelock.
 *
 * Each test is named after a clause of the ruling.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { FloorService } from '../src/service.js';
import { FloorBook } from '../src/book.js';
import { FluidFairnessLogic } from '../src/logics.js';
import type { Bid, FloorEvent } from '../src/types.js';

const T0 = 1_000_000;

function room(svc: FloorService) {
  return svc.registerRoom('loopback://suspension', 'test:local', new FluidFairnessLogic({ speechLeaseMs: 1000 }), T0);
}

function bid(book: FloorBook, participantId: string, bidId: string, now: number, kind: Bid['readinessKind'] = 'prepared') {
  return book.createBid({ participantId, bidId, readinessKind: kind, createdAt: now, expiresAt: null }, now);
}

function eventsOf(book: FloorBook, type: FloorEvent['type']) {
  return book.eventLog().filter((e) => e.type === type);
}

let svc: FloorService;
beforeEach(() => {
  svc = new FloorService('pe_suspension');
});

describe('§2.2 stale-head suspension', () => {
  it('a stale-head decline suspends the exact revision: one durable bid/suspended, no re-offer against the same head', () => {
    const r = room(svc);
    bid(r.book, 'stale-bot', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'stale-head', 'head-A');

    const b = r.book.listBids().find((x) => x.bidId === 'b1')!;
    assert.equal(b.state, 'suspended');
    assert.equal(b.suspendedOnHead, 'head-A');
    assert.equal(eventsOf(r.book, 'bid/suspended').length, 1, 'exactly one durable suspension event');

    // The churn engine, denied: arbitration finds nothing to offer while
    // the head stands still.
    for (let t = T0 + 4; t < T0 + 60; t += 5) {
      assert.equal(svc.arbitrate(r.roomId, t).grant, undefined, 'no re-offer of a suspended revision');
    }
    assert.equal(eventsOf(r.book, 'grant/offered').length, 1, 'the one original offer, never repeated');
  });

  it('an authoritative head advance restores eligibility; a repeated head does not', () => {
    const r = room(svc);
    bid(r.book, 'stale-bot', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'stale-head', 'head-A');

    r.book.noteHead('head-A', T0 + 4); // not an advance
    assert.equal(r.book.listBids().find((x) => x.bidId === 'b1')!.state, 'suspended');

    r.book.noteHead('head-B', T0 + 5); // an advance
    const reactivated = eventsOf(r.book, 'bid/reactivated');
    assert.equal(reactivated.length, 1);
    assert.equal((reactivated[0].data as { cause: string }).cause, 'head-advance');
    const g2 = svc.arbitrate(r.roomId, T0 + 6).grant;
    assert.equal(g2?.participantId, 'stale-bot', 'eligible again after head advance');
  });

  it('participant reaffirmation (amend) restores eligibility and preserves original queue age', () => {
    const r = room(svc);
    bid(r.book, 'stale-bot', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'stale-head', 'head-A');

    const revived = r.book.amendBid('b1', { subjectRef: 'head-A-was-fine-actually' }, T0 + 10);
    assert.equal(revived.state, 'open');
    assert.equal(revived.revision, 2, 'reaffirmation is a revision');
    assert.equal(revived.createdAt, T0 + 1, 'queue age preserved (ruling: fairness must not punish a correct refusal)');
    const causes = eventsOf(r.book, 'bid/reactivated').map((e) => (e.data as { cause: string }).cause);
    assert.deepEqual(causes, ['reaffirmation']);
  });

  it('replace-under-stable-id on a suspended bid reaffirms and preserves createdAt', () => {
    const r = room(svc);
    bid(r.book, 'stale-bot', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'stale-head', 'head-A');

    // Replacement arrives as a FRESH envelope (new client-side id) and
    // folds into the stable original bid — the FINDING-3 contract.
    const replaced = bid(r.book, 'stale-bot', 'b1-replacement', T0 + 20);
    assert.equal(replaced.bidId, 'b1', 'stable id survives replacement');
    assert.equal(replaced.state, 'open');
    assert.equal(replaced.createdAt, T0 + 1, 'replacement preserves original createdAt (FINDING-3 contract, unchanged)');
  });

  it('an offer reaching a suspended revision is a service invariant failure: loud book/invariant receipt, then refusal', () => {
    const r = room(svc);
    bid(r.book, 'stale-bot', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'stale-head', 'head-A');

    assert.throws(
      () => r.book.offerGrant('b1', 1, { acceptBy: T0 + 100, speechLeaseMs: 1000 }, T0 + 10),
      /invariant/,
    );
    const inv = eventsOf(r.book, 'book/invariant');
    assert.equal(inv.length, 1);
    assert.equal((inv[0].data as { kind: string }).kind, 'offer-of-suspended-revision');
    assert.equal((inv[0].data as { blockedHead: string }).blockedHead, 'head-A');
  });

  it('suspension keeps the decline responsive: no ignored-offer strikes, no lapse, ever', () => {
    const r = room(svc);
    bid(r.book, 'stale-bot', 'b1', T0 + 1);
    // Three full suspend/head-advance/re-offer/suspend cycles — the shape
    // that lapsed a bid at K=3 when offers were IGNORED must not lapse a
    // bid whose owner answers every one.
    let t = T0 + 2;
    for (let i = 0; i < 3; i++) {
      const g = svc.arbitrate(r.roomId, t).grant!;
      svc.decline(r.roomId, g.grantId, t + 1, 'stale-head', `head-${i}`);
      r.book.noteHead(`head-${i + 1}`, t + 2);
      t += 10;
    }
    const b = r.book.listBids().find((x) => x.bidId === 'b1')!;
    assert.equal(b.ignoredOffers, 0, 'declining is participation, not absence');
    assert.notEqual(b.state, 'lapsed');
    assert.equal(eventsOf(r.book, 'bid/lapsed').length, 0);
  });

  it('fairness does not punish a correct refusal: after reactivation the suspended bidder still outranks a younger bid', () => {
    const r = room(svc);
    bid(r.book, 'careful', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'stale-head', 'head-A');
    bid(r.book, 'newcomer', 'b2', T0 + 5); // younger competitor arrives during suspension
    r.book.noteHead('head-B', T0 + 6);
    const g2 = svc.arbitrate(r.roomId, T0 + 7).grant!;
    assert.equal(g2.participantId, 'careful', 'preserved queue age wins; the refusal cost nothing');
  });

  it('a non-stale-head decline does not suspend (the generic path is unchanged)', () => {
    const r = room(svc);
    bid(r.book, 'chooser', 'b1', T0 + 1);
    const g1 = svc.arbitrate(r.roomId, T0 + 2).grant!;
    svc.decline(r.roomId, g1.grantId, T0 + 3, 'content-withdrawn');
    const b = r.book.listBids().find((x) => x.bidId === 'b1')!;
    assert.equal(b.state, 'open');
    assert.equal(eventsOf(r.book, 'bid/suspended').length, 0);
    assert.equal(svc.arbitrate(r.roomId, T0 + 4).grant?.participantId, 'chooser', 'immediately re-grantable');
  });
});

// ── Host seam: traveling discriminators (Mica review 2026-08-19) ──
// The race repair and the stamp lifecycle live in trial/host.ts, not the
// book — so they are exercised here through the REAL ticking host and
// transport path, per the review: removing offer-head stamping or the
// post-decline reconcile must fail these.

import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { parseEvent } from '../trial/band.js';

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

function hostRig(acceptTtl?: number) {
  const bus = new LoopbackBus();
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({
      speechLeaseMs: 1000,
      ...(acceptTtl ? { acceptTtlMs: { prepared: acceptTtl, intent: acceptTtl, manual: acceptTtl, urgent: acceptTtl } } : {}),
    }),
    { tickMs: 25, idleAfterMs: 600_000 },
  );
  const lines = () =>
    bus.log
      .filter((m) => m.surface === 'control' && m.authorId === 'floor-service')
      .map((m) => parseEvent(m.text))
      .filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  const heads = () => (host as unknown as { offerHeads: Map<string, string> }).offerHeads;
  return { bus, host, lines, heads };
}

describe('host seam: stale-head suspension through the real transport path', () => {
  it('race repair: offer stamped A, head advances to B before the decline — suspension records A, then reactivates immediately with no further speech', async () => {
    const { bus, host, lines } = hostRig();
    host.start();
    try {
      const headA = bus.post('ra', 'ra', 'room', 'speech A');
      bus.post('bot', 'bot', 'control', '!floor join');
      await until(() => lines().some((e) => e.type === 'joined'), 2_000);
      bus.post('bot', 'bot', 'control', `!floor bid readiness=prepared subject=${headA}`);
      assert.ok(await until(() => lines().some((e) => e.type === 'grant/offered'), 2_000), 'offer emitted');
      const offer = lines().find((e) => e.type === 'grant/offered')!;
      assert.equal(offer.fields.head, headA, 'offer stamped with head A');

      // The room moves on while the offer is in flight.
      bus.post('ra', 'ra', 'room', 'speech B');
      await new Promise((r) => setTimeout(r, 40));

      // The decline judges the OFFER's head — and the current head is
      // already past it, so suspension must resolve immediately.
      bus.post('bot', 'bot', 'control', `!floor decline ${offer.fields.grantId} reason=stale-head`);

      assert.ok(
        await until(() => lines().some((e) => e.type === 'bid/suspended'), 2_000),
        'suspension recorded',
      );
      const suspended = lines().find((e) => e.type === 'bid/suspended')!;
      assert.equal(suspended.fields.blockedHead, headA, 'blocks the head the decliner judged, not decline-time head');

      // No further room speech from here: reactivation must come from the
      // post-decline reconcile alone, and the bid must be re-offerable.
      assert.ok(
        await until(() => lines().some((e) => e.type === 'bid/reactivated'), 2_000),
        'immediate reactivation — the blocking condition was already gone',
      );
      assert.ok(
        await until(() => lines().filter((e) => e.type === 'grant/offered').length >= 2, 2_000),
        're-offered without any new speech',
      );
    } finally {
      host.stop();
    }
  });

  it('offerHeads is bounded to unresolved grants: read-then-delete across decline, release, and expiry', async () => {
    const { bus, host, lines, heads } = hostRig(150);
    host.start();
    try {
      const headA = bus.post('ra', 'ra', 'room', 'speech A');
      bus.post('bot', 'bot', 'control', '!floor join');
      await until(() => lines().some((e) => e.type === 'joined'), 2_000);

      // Cycle 1 — stale-head decline: the stamp must be read (suspension
      // carries it) and then dropped.
      bus.post('bot', 'bot', 'control', `!floor bid readiness=prepared subject=${headA}`);
      await until(() => lines().some((e) => e.type === 'grant/offered'), 2_000);
      const g1 = lines().find((e) => e.type === 'grant/offered')!;
      bus.post('ra', 'ra', 'room', 'speech B');
      await new Promise((r) => setTimeout(r, 40));
      bus.post('bot', 'bot', 'control', `!floor decline ${g1.fields.grantId} reason=stale-head`);
      await until(() => lines().some((e) => e.type === 'bid/suspended'), 2_000);
      assert.equal(
        lines().find((e) => e.type === 'bid/suspended')!.fields.blockedHead,
        headA,
        'stamp was read before deletion',
      );
      assert.ok(await until(() => !heads().has(g1.fields.grantId), 2_000), 'declined grant dropped from offerHeads');

      // Cycle 2 — accept and release: stamp survives the accept, dies with
      // the terminal.
      await until(() => lines().filter((e) => e.type === 'grant/offered').length >= 2, 2_000);
      const g2 = lines().filter((e) => e.type === 'grant/offered')[1];
      assert.ok(heads().has(g2.fields.grantId), 'live offer keeps its stamp');
      bus.post('bot', 'bot', 'control', `!floor accept ${g2.fields.grantId}`);
      await until(() => lines().some((e) => e.type === 'grant/accepted'), 2_000);
      assert.ok(heads().has(g2.fields.grantId), 'accepted grant is unresolved — stamp retained');
      bus.post('bot', 'bot', 'control', `!floor release ${g2.fields.grantId}`);
      assert.ok(await until(() => !heads().has(g2.fields.grantId), 2_000), 'released grant dropped');

      // Cycle 3 — offer expiry (150ms accept TTL): the sweep's terminal
      // also cleans up.
      bus.post('ra', 'ra', 'room', 'speech C');
      bus.post('bot', 'bot', 'control', '!floor bid readiness=intent');
      await until(() => lines().filter((e) => e.type === 'grant/offered').length >= 3, 2_000);
      const g3 = lines().filter((e) => e.type === 'grant/offered')[2];
      assert.ok(
        await until(() => lines().some((e) => e.type === 'grant/offer-expired' && e.fields.grantId === g3.fields.grantId), 3_000),
        'offer expired',
      );
      assert.ok(await until(() => !heads().has(g3.fields.grantId), 2_000), 'expired grant dropped');
      assert.equal(heads().size, 0, 'no unresolved grants → empty map');
    } finally {
      host.stop();
    }
  });
});
