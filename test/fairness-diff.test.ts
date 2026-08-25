/**
 * Conformance for the fairness-diff replayer (shadow pass 2). Synthetic
 * fixtures with known-correct classifications — no harvest data enters the
 * repo (raw metadata stays local per the stage-0 disclosure).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replay, synthesizeBidAt, publicAggregate, DEFAULT_KNOBS, type RhythmRecord } from '../trial/fairness-diff.js';

const T0 = 1_000_000;
let seq = 0;
const msg = (at: number, authorId: string, bytes = 100): RhythmRecord => ({
  at, authorId, bytes, messageId: `m${++seq}`,
});

describe('fairness-diff replayer', () => {
  it('S1: an agent burst coalesces into one turn — every message concordant, one grant', () => {
    const a = 'webhook:BotA';
    const r = replay([
      msg(T0, a), msg(T0 + 400, a), msg(T0 + 900, a), // gaps < burstReleaseMs
    ]);
    assert.equal(r.interventionRate, 0);
    assert.equal(r.classes['accept-on-speech'], 1);
    assert.equal(r.classes['held-coalesced'], 2);
    assert.equal(r.clockFit.burstsCoalesced, 2);
    assert.equal(r.concordance.offersIssued, 1);
  });

  it('S2: two speakers alternating at a relaxed pace — zero interventions, grants alternate', () => {
    const a = 'webhook:BotA';
    const b = 'user:1111';
    const r = replay([
      msg(T0, a), msg(T0 + 30_000, b), msg(T0 + 60_000, a), msg(T0 + 90_000, b),
    ]);
    assert.equal(r.interventionRate, 0);
    assert.equal(r.classes['accept-on-speech'], 4);
    assert.equal(r.fairness.byKind.human.grants, 2);
    assert.equal(r.fairness.byKind.agent.grants, 2);
  });

  it('S3: a rapid handoff inside an agent burst window is blocked — the C-class violation', () => {
    const a = 'webhook:BotA';
    const b = 'user:1111';
    const r = replay([
      msg(T0, a),
      msg(T0 + 1_000, b), // agent grant still held (burstReleaseMs 2500)
    ]);
    assert.equal(r.classes.blocked, 1);
    assert.equal(r.interventionByKind.human, 1);
    const blocked = r.outcomes.find((o) => o.cls === 'blocked');
    assert.ok(blocked?.contended, 'a 1s handoff is inside the contention window');
  });

  it('S4: a human slower than the manual accept-TTL shows up as the C2 mismatch', () => {
    const h = 'user:2222';
    // Bid at T0 (M0: bid==speech... so slow-speech needs M1): use M1 so the
    // bid lands early and the offer's 60s manual TTL can expire before speech.
    const r = replay(
      [msg(T0, h, 100_000)], // 100KB at 6 B/s → δ capped at 120s: bid at T0-120s
      { model: 'M1' },
    );
    // Offer issued at bid time; speech arrives 120s later; manual TTL is
    // 60s → the offer expired before the human spoke.
    assert.equal(r.concordance.offerExpiries, 1);
    assert.equal(r.classes['post-expiry'] + r.classes.unoffered, 1);
    assert.equal(r.clockFit.leaseExpiries, 0, 'lease expiries are structurally absent under accept-on-speech');
  });

  it('S5: M1 bid synthesis never crosses the author\'s previous message', () => {
    const rec = msg(T0 + 1_000, 'user:3333', 600); // δ = 100s, but prev msg at T0
    const bidAt = synthesizeBidAt(rec, T0, { ...DEFAULT_KNOBS, model: 'M1' });
    assert.equal(bidAt, T0 + 1);
  });

  it('S6: replay is deterministic — identical inputs produce identical reports', () => {
    const stream = [
      msg(T0, 'webhook:BotA'), msg(T0 + 800, 'webhook:BotA'), msg(T0 + 5_000, 'user:1111'),
      msg(T0 + 12_000, 'webhook:BotB'), msg(T0 + 12_500, 'user:1111'), msg(T0 + 90_000, 'webhook:BotA'),
    ];
    const r1 = replay(stream, { model: 'M1' });
    const r2 = replay(stream, { model: 'M1' });
    assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(r2)));
  });

  it('S7: the public aggregate carries no per-identity rows and no outcome stream', () => {
    const r = replay([msg(T0, 'user:1111'), msg(T0 + 10_000, 'webhook:BotA')]);
    const pub = publicAggregate(r) as Record<string, unknown>;
    assert.equal(pub.perIdentity, undefined);
    assert.equal(pub.outcomes, undefined);
    assert.ok(pub.interventionRate !== undefined);
  });

  it('S8: violations never mutate the floor — the holder\'s grant survives a blocked speech', () => {
    const a = 'webhook:BotA';
    const b = 'webhook:BotB';
    const r = replay([
      msg(T0, a),
      msg(T0 + 500, b),  // blocked: a holds until T0+... burst window
      msg(T0 + 1_000, a), // a's burst continues — still coalescing
    ]);
    assert.equal(r.classes.blocked, 1);
    assert.equal(r.classes['held-coalesced'], 1);
    assert.equal(r.interventionByKind.agent > 0, true);
  });
});
