/**
 * Phase-3 discriminators — Mica's rulings on trial findings 7–10
 * (2026-08-13). Every test here FAILS on the pre-ruling head (b01d8dc):
 * that is its purpose. Numbering follows Mica's required discriminator set;
 * items 1 and 9 (host-level: newcomer wake, suspend/resume ordering) live
 * in trial/run-loopback.ts as scenarios S6/S7; item 10 is the rest of this
 * suite plus the loopback scenarios staying green.
 *
 * Deterministic: explicit clocks, no randomness — same discipline as
 * conformance.test.ts.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { FloorService } from '../src/service.js';
import { FloorBook } from '../src/book.js';
import { FluidFairnessLogic } from '../src/logics.js';
import type { Bid } from '../src/types.js';

const T0 = 1_754_000_000_000;

/** Compact clocks for lapse walks: accept-TTL 20s (intent), speech lease
 *  30s, backoff 10s capped 20s. */
function room(svc: FloorService) {
  return svc.registerRoom(
    'trial://phase3/room',
    'auth:test',
    new FluidFairnessLogic({ speechLeaseMs: 30_000, expiryBackoffMs: 10_000, expiryBackoffCapMs: 20_000 }),
    T0,
  );
}

function bid(book: FloorBook, participantId: string, bidId: string, now: number, kind: Bid['readinessKind'] = 'intent') {
  return book.createBid({ participantId, bidId, readinessKind: kind, createdAt: now, expiresAt: null }, now);
}

let svc: FloorService;
beforeEach(() => {
  svc = new FloorService('pe_phase3');
});

describe('FINDING-8 — two clocks: offer accept-TTL vs speech lease (discriminators 2, 3)', () => {
  it('D2: 8.5s pre-accept jitter still yields the FULL post-accept speech lease', () => {
    const r = room(svc);
    bid(r.book, 'jittery', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    assert.equal(g.acceptBy, T0 + 2 + 20_000, 'offer clock runs from issue');
    // Relay jitter: the accept lands 8.5s after the offer — run B's g5 case.
    const accepted = r.book.acceptGrant(g.grantId, T0 + 2 + 8_500);
    assert.equal(
      accepted.leaseUntil,
      T0 + 2 + 8_500 + 30_000,
      'speech lease counts from acceptance — pre-accept delay costs the holder nothing',
    );
    // On the previous head this grant died at offer+10s/30s regardless of
    // the accept, branding the holder's speech a violation (run B, false
    // violations ×2).
  });

  it('D3: an unanswered offer consumes only its accept-TTL, never a speech lease', () => {
    const r = room(svc);
    bid(r.book, 'absent', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    r.book.tick(T0 + 2 + 20_001); // one ms past accept-TTL
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'offer-expired');
    assert.equal(r.book.liveGrant, null, 'floor is free at TTL, not at TTL + lease');
  });

  it('a late accept is refused explicitly, with the offer terminated offer-expired', () => {
    const r = room(svc);
    bid(r.book, 'late', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    assert.throws(() => r.book.acceptGrant(g.grantId, g.acceptBy + 1), /late accept refused/);
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'offer-expired');
  });

  it('separate terminals: accepted-then-overrun is lease-expired, not offer-expired', () => {
    const r = room(svc);
    bid(r.book, 'holder', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    r.book.acceptGrant(g.grantId, T0 + 3);
    r.book.tick(T0 + 3 + 30_001);
    assert.equal(r.book.receiptFor(g.grantId)?.terminal, 'lease-expired');
  });
});

describe('FINDING-9 — bid/lapsed after three ignored offers (discriminators 4, 5, 8)', () => {
  /** Walk one solo unresponsive bidder through offer/expiry cycles,
   *  honoring the backoff holds between regrants. Returns the times used. */
  function walkExpiries(r: ReturnType<FloorService['registerRoom']>, n: number): number {
    bid(r.book, 'ghost', 'b1', T0 + 1);
    let t = T0 + 2;
    for (let i = 0; i < n; i++) {
      const g = svc.arbitrate(r.roomId, t).grant;
      assert.ok(g, `offer ${i + 1} issued at ${t - T0}`);
      t = g.acceptBy + 1 + 1; // let the accept-TTL elapse
      svc.arbitrate(r.roomId, t); // tick: offer-expired
      t += 20_001; // clear the (capped) backoff before the next round
    }
    return t;
  }

  it('D4: three ignored offers lapse the bid; a fourth grant never happens', () => {
    const r = room(svc);
    const t = walkExpiries(r, 3);
    const b = r.book.listBids().find((x) => x.bidId === 'b1')!;
    assert.equal(b.state, 'lapsed');
    assert.equal(b.ignoredOffers, 3);
    const lapse = r.book.eventLog().find((e) => e.type === 'bid/lapsed');
    assert.ok(lapse, 'lapse is a ledger event');
    assert.equal(lapse!.data.cause, 'ignored-offers');
    assert.equal(lapse!.data.expiryCount, 3);
    const after = svc.arbitrate(r.roomId, t + 1);
    assert.equal(after.decision.kind, 'hold', 'a lapsed bid receives no further grants');
    const offers = r.book.eventLog().filter((e) => e.type === 'grant/offered');
    assert.equal(offers.length, 3, 'exactly three offers, never a fourth');
    // On the previous head this loop ran forever: run B granted two such
    // bids 230 times in three hours.
  });

  it('D5: an explicit fresh bid restores eligibility after lapse', () => {
    const r = room(svc);
    const t = walkExpiries(r, 3);
    bid(r.book, 'ghost', 'b2', t + 10);
    const revived = svc.arbitrate(r.roomId, t + 11).grant;
    assert.equal(revived?.participantId, 'ghost', 're-entry requires and rewards an explicit re-bid');
    assert.equal(revived?.bidId, 'b2', 'the lapsed bid stays terminal; the fresh bid is granted');
  });

  it('D8: decline is responsive — three declines neither lapse the bid nor count as ignored', () => {
    const r = room(svc);
    bid(r.book, 'chooser', 'b1', T0 + 1);
    let t = T0 + 2;
    for (let i = 0; i < 3; i++) {
      const g = svc.arbitrate(r.roomId, t).grant!;
      svc.decline(r.roomId, g.grantId, t + 1, 'stale-head');
      t += 10;
    }
    const b = r.book.listBids().find((x) => x.bidId === 'b1')!;
    assert.equal(b.state, 'open', 'declining is participation, not absence');
    assert.equal(b.ignoredOffers, 0);
    const g4 = svc.arbitrate(r.roomId, t).grant;
    assert.equal(g4?.participantId, 'chooser', 'still grantable after three responsive declines');
  });

  it('acceptance clears the ignored-offer streak', () => {
    const r = room(svc);
    const t = walkExpiries(r, 2); // two strikes, still open
    const g = svc.arbitrate(r.roomId, t).grant!;
    r.book.acceptGrant(g.grantId, t + 1);
    const b = r.book.listBids().find((x) => x.bidId === 'b1')!;
    assert.equal(b.ignoredOffers, 0, 'one acceptance resets the lapse counter');
  });
});

describe('FINDING-10 — degradation telemetry, N=3 (discriminators 6, 7)', () => {
  /** Two never-accepting bidders alternate offer expiries — the run-B
   *  churn shape, in miniature. Driven through the book directly: the
   *  telemetry is a book property and must stay decoupled from any logic's
   *  fairness/backoff choices. Alternation keeps every bid below the K=3
   *  per-bid lapse so the room-wide streak is what's under test. */
  function churn(r: ReturnType<FloorService['registerRoom']>, expiries: number): number {
    bid(r.book, 'z1', 'b1', T0 + 1);
    bid(r.book, 'z2', 'b2', T0 + 2);
    let t = T0 + 3;
    for (let i = 0; i < expiries; i++) {
      const b = r.book.openBids().find((x) => x.participantId === (i % 2 === 0 ? 'z1' : 'z2'))!;
      r.book.offerGrant(b.bidId, b.revision, { acceptBy: t + 1_000, speechLeaseMs: 30_000 }, t);
      r.book.tick(t + 1_001); // accept-TTL elapses unanswered
      t += 2_000;
    }
    return t;
  }

  it('D6: the degradation signal fires exactly once at the threshold, and never alters arbitration', () => {
    const r = room(svc);
    churn(r, 4);
    const degraded = r.book.eventLog().filter((e) => e.type === 'book/degraded');
    assert.equal(degraded.length, 1, 'once per episode — the fourth expiry does not re-emit');
    assert.equal(degraded[0].data.noAcceptStreak, 3);
    const offers = r.book.eventLog().filter((e) => e.type === 'grant/offered');
    assert.equal(offers.length, 4, 'telemetry only: grants kept flowing exactly as fairness dictated');
  });

  it('D7: an acceptance resets the room streak and emits one recovery receipt', () => {
    const r = room(svc);
    const t = churn(r, 3); // degraded episode open
    const g = svc.arbitrate(r.roomId, t).grant!;
    r.book.acceptGrant(g.grantId, t + 1);
    const recovered = r.book.eventLog().filter((e) => e.type === 'book/recovered');
    assert.equal(recovered.length, 1, 'recovery receipt on the next acceptance');
    // The streak restarted: one further expiry is two short of a new episode.
    r.book.releaseGrant(g.grantId, t + 2);
    const g2 = svc.arbitrate(r.roomId, t + 20_100).grant;
    if (g2) svc.arbitrate(r.roomId, g2.acceptBy + 2);
    const degraded = r.book.eventLog().filter((e) => e.type === 'book/degraded');
    assert.equal(degraded.length, 1, 'no second degradation until a fresh streak of three');
  });
});

describe('host-sleep ruling — truthful lateness (discriminator 9, book half)', () => {
  it('an expiry detected late carries its scheduled deadline and overdueMs — never represented as punctual', () => {
    const r = room(svc);
    bid(r.book, 'napper', 'b1', T0 + 1);
    const g = svc.arbitrate(r.roomId, T0 + 2).grant!;
    // The host slept 15 minutes (session A's g27): detection is late, the
    // receipt says so.
    r.book.tick(T0 + 2 + 20_000 + 900_000);
    const ev = r.book.eventLog().find((e) => e.type === 'grant/offer-expired')!;
    assert.equal(ev.data.deadline, g.acceptBy);
    assert.equal(ev.data.overdueMs, 900_000);
  });
});
