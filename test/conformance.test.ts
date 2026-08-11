/**
 * FLOOR-RFC-001 conformance suite. Test names quote the RFC's invariants;
 * a failure here is a protocol violation, not a style disagreement.
 * Everything is deterministic: explicit clocks, no randomness.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { FloorService } from '../src/service.js';
import { FloorBook } from '../src/book.js';
import { FluidFairnessLogic, ChairedLogic } from '../src/logics.js';
import { digestContract } from '../src/contract.js';
import type { Bid } from '../src/types.js';

const T0 = 1_754_000_000_000;

function fluidRoom(svc: FloorService) {
  return svc.registerRoom('eidoverse://commons/hearth', 'auth:sequencer', new FluidFairnessLogic({ leaseMs: 10_000 }), T0);
}

function bid(book: FloorBook, participantId: string, bidId: string, now: number, kind: Bid['readinessKind'] = 'intent') {
  return book.createBid(
    { participantId, bidId, readinessKind: kind, createdAt: now, expiresAt: null },
    now,
  );
}

let svc: FloorService;
beforeEach(() => {
  svc = new FloorService('pe_test1');
});

describe('a bid never self-grants', () => {
  it('creating a bid changes nothing about the floor; only arbitration grants', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    assert.equal(room.book.liveGrant, null, 'bid alone must not grant');
    const { grant } = svc.arbitrate(room.roomId, T0 + 2);
    assert.ok(grant, 'the logic, not the bid, produces the grant');
    assert.equal(grant.participantId, 'mica');
  });
});

describe('positive expiry: grants cannot be open-ended', () => {
  it('offerGrant refuses non-finite or non-future leaseUntil', () => {
    const room = fluidRoom(svc);
    const b = bid(room.book, 'mica', 'b1', T0 + 1);
    assert.throws(() => room.book.offerGrant(b.bidId, b.revision, Infinity, T0 + 2), /positive expiry/);
    assert.throws(() => room.book.offerGrant(b.bidId, b.revision, T0 + 2, T0 + 2), /positive expiry/);
  });

  it('an overdue lease expires on tick with an idempotent receipt', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    const { grant } = svc.arbitrate(room.roomId, T0 + 2);
    room.book.tick(T0 + 20_000);
    const receipt = room.book.receiptFor(grant!.grantId);
    assert.equal(receipt?.terminal, 'expired');
    assert.equal(room.book.liveGrant, null);
  });

  it('continuation must extend to a finite future time', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    const { grant } = svc.arbitrate(room.roomId, T0 + 2);
    room.book.acceptGrant(grant!.grantId, T0 + 3);
    assert.throws(() => room.book.continueGrant(grant!.grantId, T0 + 1, T0 + 4), /positive expiry/);
    room.book.continueGrant(grant!.grantId, T0 + 60_000, T0 + 4);
    assert.equal(room.book.liveGrant?.leaseUntil, T0 + 60_000);
  });
});

describe('revoke-before-regrant: one live grant per room, including handoffs', () => {
  it('a second grant is refused while one is live', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    const b2 = bid(room.book, 'sol', 'b2', T0 + 2);
    svc.arbitrate(room.roomId, T0 + 3);
    assert.throws(() => room.book.offerGrant(b2.bidId, b2.revision, T0 + 30_000, T0 + 4), /revoke-before-regrant/);
  });

  it('handoff requires a terminal receipt first', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    bid(room.book, 'sol', 'b2', T0 + 2);
    const { grant: g1 } = svc.arbitrate(room.roomId, T0 + 3);
    svc.release(room.roomId, g1!.grantId, T0 + 4);
    const { grant: g2 } = svc.arbitrate(room.roomId, T0 + 5);
    assert.ok(g2);
    assert.equal(g2.participantId, 'sol');
  });
});

describe('grants bind the exact bid revision they answer', () => {
  it('a stale revision is refused at offer time', () => {
    const room = fluidRoom(svc);
    const b = bid(room.book, 'mica', 'b1', T0 + 1);
    const r1 = b.revision;
    room.book.amendBid('b1', { subjectRef: 'agenda:2' }, T0 + 2);
    assert.throws(() => room.book.offerGrant('b1', r1, T0 + 30_000, T0 + 3), /stale bid revision/);
  });
});

describe('epoch death: no zombie speaking authority', () => {
  it('process restart kills active grants; durable bids come back stale and must be re-affirmed', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    bid(room.book, 'sol', 'b2', T0 + 2);
    const { grant } = svc.arbitrate(room.roomId, T0 + 3);
    assert.ok(grant);

    const restored = FloorService.restore(
      'pe_test2',
      [{ roomId: room.roomId, bindings: room.bindings, logic: new FluidFairnessLogic({ leaseMs: 10_000 }), durableBids: room.book.listBids() }],
      T0 + 10,
    );
    const book2 = restored.room(room.roomId).book;
    assert.equal(book2.liveGrant, null, 'grants never survive restart');
    assert.ok(book2.listBids().every((b) => b.state === 'stale'), 'durable bids require revalidation');

    // Stale bids are not matchable until re-affirmed under the new contract.
    const held = restored.arbitrate(room.roomId, T0 + 11);
    assert.equal(held.decision.kind, 'hold');
    book2.amendBid('b1', {}, T0 + 12); // re-affirmation
    const { grant: g2 } = restored.arbitrate(room.roomId, T0 + 13);
    assert.equal(g2?.participantId, 'mica');
    assert.equal(g2?.processEpoch, 'pe_test2');
  });

  it('logic swap creates a new logicEpoch, revokes the live grant, and stales open bids', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    const { grant } = svc.arbitrate(room.roomId, T0 + 2);
    const epochBefore = room.book.currentContract!.logicEpoch;

    room.book.activateContract(new ChairedLogic('antra').contract, T0 + 5);
    assert.equal(room.book.currentContract!.logicEpoch, epochBefore + 1);
    assert.equal(room.book.receiptFor(grant!.grantId)?.terminal, 'revoked');
    assert.ok(room.book.listBids().every((b) => b.state === 'stale'));
  });
});

describe('idempotent terminal receipts', () => {
  it('exactly one terminal state; re-termination returns the same receipt', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    const { grant } = svc.arbitrate(room.roomId, T0 + 2);
    const r1 = svc.release(room.roomId, grant!.grantId, T0 + 3, { voiced: 'hello', estimated: false });
    const r2 = room.book.revokeGrant(grant!.grantId, T0 + 4, 'late revoke attempt');
    assert.equal(r2, r1, 'second terminal returns the first receipt unchanged');
    assert.equal(r2.terminal, 'released');
    assert.equal(room.book.receiptFor(grant!.grantId), r1);
  });
});

describe('the acknowledged() trace never mutates book or grant state', () => {
  it('✅ is recorded and replayable but touches nothing', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    const { grant } = svc.arbitrate(room.roomId, T0 + 2);
    const bidsBefore = JSON.stringify(room.book.listBids());
    const grantBefore = JSON.stringify(room.book.liveGrant);
    room.book.acknowledged('agenda:1', 'labclaude', T0 + 3);
    room.book.acknowledged('agenda:1', 'mythos', T0 + 4);
    assert.equal(JSON.stringify(room.book.listBids()), bidsBefore);
    assert.equal(JSON.stringify(room.book.liveGrant), grantBefore);
    assert.equal(room.book.liveGrant?.grantId, grant!.grantId);
    const acks = room.book.eventLog().filter((e) => e.type === 'acknowledged');
    assert.equal(acks.length, 2, 'the trace is recorded for replay');
  });
});

describe('deterministic replay', () => {
  it('same inputs produce the same event log', () => {
    const run = () => {
      const s = new FloorService('pe_same');
      const room = s.registerRoom('discord://g/c', 'auth:x', new FluidFairnessLogic({ leaseMs: 5_000 }), T0);
      bid(room.book, 'a', 'b1', T0 + 1);
      bid(room.book, 'b', 'b2', T0 + 2, 'urgent');
      const { grant } = s.arbitrate(room.roomId, T0 + 3);
      s.release(room.roomId, grant!.grantId, T0 + 4);
      s.arbitrate(room.roomId, T0 + 5);
      return JSON.stringify(room.book.eventLog());
    };
    assert.equal(run(), run());
  });
});

describe('binding claims: addressable, never auto-merged', () => {
  it('same locator + same provenance lands on the same room; different provenance is refused', () => {
    const room = fluidRoom(svc);
    svc.claimBinding(room.roomId, 'eidoverse://commons/hearth', 'auth:sequencer', T0 + 1);
    assert.equal(svc.findRoomByBinding('eidoverse://commons/hearth')?.roomId, room.roomId);
    assert.throws(
      () => svc.claimBinding(room.roomId, 'eidoverse://commons/hearth', 'auth:someone-else', T0 + 2),
      /different provenance/,
    );
  });

  it('a different locator never merges implicitly; declared sharing spans one book', () => {
    const room = fluidRoom(svc);
    assert.equal(svc.findRoomByBinding('discord://g/hearth'), undefined, 'name similarity is not identity');
    svc.declareSharedBinding(room.roomId, 'discord://g/hearth', 'auth:portal', T0 + 1);
    assert.equal(svc.findRoomByBinding('discord://g/hearth')?.roomId, room.roomId);
    // One live grant excludes holders across ALL bindings — same book.
    bid(room.book, 'mica', 'b1', T0 + 2);
    svc.arbitrate(room.roomId, T0 + 3);
    const b2 = bid(room.book, 'sol', 'b2', T0 + 4);
    assert.throws(() => room.book.offerGrant(b2.bidId, b2.revision, T0 + 30_000, T0 + 5), /revoke-before-regrant/);
  });
});

describe('fluid fairness: no starvation, no double-holding', () => {
  it('three talkative participants cycle; nobody is starved', () => {
    const room = fluidRoom(svc);
    const holders: string[] = [];
    let now = T0;
    const rebidSeq: Record<string, number> = {};
    for (const p of ['a', 'b', 'c']) bid(room.book, p, `bid-${p}-0`, ++now);
    for (let turn = 0; turn < 9; turn++) {
      const { grant } = svc.arbitrate(room.roomId, ++now);
      assert.ok(grant, `turn ${turn} should grant`);
      holders.push(grant.participantId);
      svc.release(room.roomId, grant.grantId, ++now);
      // a filled order is consumed; a talkative participant places a NEW bid
      const p = grant.participantId;
      rebidSeq[p] = (rebidSeq[p] ?? 0) + 1;
      bid(room.book, p, `bid-${p}-${rebidSeq[p]}`, ++now);
    }
    for (const p of ['a', 'b', 'c']) {
      assert.equal(holders.filter((h) => h === p).length, 3, `${p} holds exactly 3 of 9 turns`);
    }
    for (let i = 1; i < holders.length; i++) {
      assert.notEqual(holders[i], holders[i - 1], 'no double-holding while others wait');
    }
  });

  it('urgent bids jump the queue', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'a', 'b1', T0 + 1);
    bid(room.book, 'b', 'b2', T0 + 2);
    bid(room.book, 'c', 'b3', T0 + 3, 'urgent');
    const { grant } = svc.arbitrate(room.roomId, T0 + 4);
    assert.equal(grant?.participantId, 'c');
  });
});

describe('chaired logic: the book informs, the chair decides', () => {
  function chairedRoom(s: FloorService) {
    return s.registerRoom('discord://g/governance', 'auth:relay', new ChairedLogic('antra'), T0);
  }

  it('arbitration alone never grants; the chair API does', () => {
    const room = chairedRoom(svc);
    const b = bid(room.book, 'fable', 'hand1', T0 + 1, 'manual');
    const held = svc.arbitrate(room.roomId, T0 + 2);
    assert.equal(held.decision.kind, 'hold');
    const grant = svc.chairGrant(room.roomId, 'antra', b.bidId, b.revision, 60_000, T0 + 3);
    assert.equal(grant.participantId, 'fable');
  });

  it('a non-chair actor is refused by the contract, and the chair is not exempt from invariants', () => {
    const room = chairedRoom(svc);
    const b = bid(room.book, 'fable', 'hand1', T0 + 1, 'manual');
    assert.throws(() => svc.chairGrant(room.roomId, 'mallory', b.bidId, b.revision, 60_000, T0 + 2), /not this room's chair/);
    svc.chairGrant(room.roomId, 'antra', b.bidId, b.revision, 60_000, T0 + 3);
    const b2 = bid(room.book, 'mica', 'hand2', T0 + 4, 'manual');
    assert.throws(
      () => svc.chairGrant(room.roomId, 'antra', b2.bidId, b2.revision, 60_000, T0 + 5),
      /revoke-before-regrant/,
      'chair power does not bypass one-live-grant',
    );
  });

  it('withdraw and the one-sentence substitute are first-class', () => {
    const room = chairedRoom(svc);
    bid(room.book, 'fable', 'hand1', T0 + 1, 'manual');
    room.book.substituteBid('hand1', 'disciplinary interventions live in the same resident-visible ledger as medical ones', T0 + 2);
    const b2 = bid(room.book, 'mica', 'hand2', T0 + 3, 'manual');
    room.book.cancelBid('hand2', T0 + 4);
    assert.equal(room.book.openBids().length, 0);
    const types = room.book.eventLog().map((e) => e.type);
    assert.ok(types.includes('bid/substituted'));
    assert.ok(types.includes('bid/cancelled'));
    void b2;
  });

  it('chair restate publishes the visible book', () => {
    const room = chairedRoom(svc);
    bid(room.book, 'fable', 'hand1', T0 + 1, 'manual');
    svc.chairRestate(room.roomId, 'antra', T0 + 2, 'queue after item 3');
    const restated = room.book.eventLog().find((e) => e.type === 'book/restated');
    assert.deepEqual(restated?.data.openBids, ['hand1']);
  });
});

describe('contract digests', () => {
  it('digest is stable across key order and changes with content', () => {
    const c1 = new ChairedLogic('antra').contract;
    const c2 = { ...c1, knobs: { ...c1.knobs } };
    assert.equal(digestContract(c1), digestContract(c2));
    const c3 = new ChairedLogic('sol').contract;
    assert.notEqual(digestContract(c1), digestContract(c3));
  });
});

describe('an expired lease charges fairness history (FINDING-1, ruling 2026-08-11)', () => {
  it('after expiry the other bidder is granted; the expired holder is backed off, then eligible again', () => {
    const room = fluidRoom(svc); // leaseMs 10_000 → backoff 20_000, cap 80_000
    bid(room.book, 'sleeper', 'b1', T0 + 1);
    bid(room.book, 'alive', 'b2', T0 + 2);
    const g1 = svc.arbitrate(room.roomId, T0 + 3).grant;
    assert.equal(g1?.participantId, 'sleeper', 'arrival order first');
    // Nobody accepts; the lease expires under the tick.
    const after = svc.arbitrate(room.roomId, T0 + 20_000);
    assert.equal(room.book.receiptFor(g1!.grantId)?.terminal, 'expired');
    assert.equal(after.grant?.participantId, 'alive', 'expiry must not leave the sleeper "never held"');
    svc.release(room.roomId, after.grant!.grantId, T0 + 21_000);
    // Sleeper's reopened bid stays ineligible during backoff even with the floor free…
    const during = svc.arbitrate(room.roomId, T0 + 25_000);
    assert.equal(during.decision.kind, 'hold', 'sleeper is in expiry backoff');
    // …and becomes eligible again once the (bounded) backoff has elapsed.
    const revived = svc.arbitrate(room.roomId, T0 + 20_000 + 20_001);
    assert.equal(revived.grant?.participantId, 'sleeper');
  });

  it('a responsive terminal clears strikes', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'p', 'b1', T0 + 1);
    const g1 = svc.arbitrate(room.roomId, T0 + 2).grant!;
    svc.arbitrate(room.roomId, T0 + 20_000); // expire → strike 1
    const g2 = svc.arbitrate(room.roomId, T0 + 40_001).grant!; // backoff elapsed, regrant
    svc.release(room.roomId, g2.grantId, T0 + 40_002); // responsive: strikes clear
    assert.notEqual(g1.grantId, g2.grantId);
    bid(room.book, 'p', 'b2', T0 + 40_003);
    const g3 = svc.arbitrate(room.roomId, T0 + 40_004).grant;
    assert.equal(g3?.participantId, 'p', 'no residual backoff after a clean release');
  });
});

describe('one open bid per participant (FINDING-3, ruling 2026-08-11)', () => {
  it('a second bid replaces the first under the stable bidId, visibly in the ledger', () => {
    const room = fluidRoom(svc);
    const first = bid(room.book, 'mica', 'b1', T0 + 1);
    const firstRevision = first.revision; // createBid mutates in place: `first` aliases the replacement
    const second = room.book.createBid(
      { participantId: 'mica', bidId: 'b2', readinessKind: 'prepared', subjectRef: 'm9', createdAt: T0 + 2, expiresAt: null },
      T0 + 2,
    );
    assert.equal(second.bidId, 'b1', 'stable identity: the replacement keeps the original bidId');
    assert.equal(second.revision, firstRevision + 1);
    assert.equal(second.readinessKind, 'prepared');
    assert.equal(room.book.openBids().length, 1, 'never two concurrent open bids for one identity');
    const replaced = room.book.eventLog().filter((e) => e.type === 'bid/replaced');
    assert.equal(replaced.length, 1, 'the replacement is a ledger event');
  });

  it('rebidding while holding a granted bid is refused', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'mica', 'b1', T0 + 1);
    svc.arbitrate(room.roomId, T0 + 2);
    assert.throws(
      () => bid(room.book, 'mica', 'b9', T0 + 3),
      /release or decline before rebidding/,
    );
  });
});

describe('bid replacement preserves queue age (ruling 2026-08-11)', () => {
  it('editing a pending turn does not forfeit queue position, and cannot alter an accepted grant', () => {
    const room = fluidRoom(svc);
    bid(room.book, 'early', 'b1', T0 + 1);
    bid(room.book, 'late', 'b2', T0 + 2);
    // early edits its pending turn well after late arrived…
    const replaced = room.book.createBid(
      { participantId: 'early', bidId: 'b3', readinessKind: 'prepared', subjectRef: 'm4', createdAt: T0 + 3, expiresAt: null },
      T0 + 3,
    );
    assert.equal(replaced.createdAt, T0 + 1, 'replacement keeps the original queue timestamp');
    // …and still wins the never-held tie-break on original arrival order.
    const g = svc.arbitrate(room.roomId, T0 + 4).grant;
    assert.equal(g?.participantId, 'early', 'edits do not send you to the back of the queue');
    // Stale authority is impossible from here: the grant binds this exact
    // revision (see "grants bind the exact bid revision they answer") and a
    // granted bid can be neither replaced (see "rebidding while holding a
    // granted bid is refused") nor amended.
    assert.throws(() => room.book.amendBid('b1', { subjectRef: 'm9' }, T0 + 5), /only open\/stale bids amend/);
  });
});
