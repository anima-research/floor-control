/**
 * Reference adapter conformance — the participant half of stage 0b,
 * driven end-to-end against the instrument core. Pins:
 *   1. the three-gesture lifecycle (begin → bid ledgered with residency;
 *      speak → accept-on-speech; abandon → bid/cancelled);
 *   2. write-only-ness: the adapter type cannot subscribe (compile-time
 *      Pick) and the runtime path never reads either surface;
 *   3. the zero-read affordances the instrument grants it: id-less
 *      cancel targets the sender's own bid, a holder's re-bid is
 *      continuation intent (no error, no replacement churn), and
 *      cancel-with-nothing-pending is a ledgered refusal, not a crash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { InboundMessage } from '../trial/transport.js';
import { ShadowBidAdapter } from '../trial/shadow-bid-adapter.js';
import { ShadowBidsCore } from '../trial/shadow-bids.js';

const AGENT = 'persona:alpha';

/** Wire an adapter's writes straight into a core as observed traffic —
 *  the agent's own identity, explicit clock. */
function rig() {
  const records: Record<string, unknown>[] = [];
  const core = new ShadowBidsCore('loopback://test/room-1', 'loopback:test', (e) => records.push(e), {
    consentingIds: [AGENT],
    clockGapThresholdMs: Number.MAX_SAFE_INTEGER,
    startedAt: 0,
  });
  let now = 1_000;
  let counter = 0;
  const clock = { advance: (ms: number) => (now += ms) };
  const deliver = (surface: 'room' | 'control', text: string): string => {
    counter += 1;
    const m: InboundMessage = {
      authorId: AGENT,
      authorName: 'alpha',
      surface,
      messageId: `m${counter}`,
      text,
      at: now,
    };
    core.observe(m);
    return m.messageId;
  };
  const adapter = new ShadowBidAdapter({
    sendRoom: async (text) => deliver('room', text),
    sendControl: async (text) => deliver('control', text),
  });
  const of = (kind: string) => records.filter((r) => r.kind === kind);
  const events = (type: string) => of('event').filter((r) => r.type === type);
  return { core, adapter, clock, of, events };
}

test('three gestures end-to-end: begin creates residency, speak is the acceptance, abandon withdraws', async () => {
  const { core, adapter, clock, of, events } = rig();

  await adapter.begin();
  assert.deepEqual(of('op').map((o) => o.op), ['join', 'bid'], 'join once, then the bid');
  assert.equal(events('bid/created').length, 1);
  assert.equal(events('grant/offered').length, 1, 'the book arbitrated against the real bid');

  clock.advance(4_000); // composing — real residency between intent and speech
  await adapter.speak('the message the intention was for');
  const outcomes = of('shadow-outcome');
  assert.deepEqual(outcomes.map((o) => o.cls), ['accept-on-speech']);

  clock.advance(10_000); // burst window (2.5s default) long past
  core.pump(15_100 + 900);
  assert.equal(events('grant/released').length, 1);

  // Compose again, think better of it.
  await adapter.begin();
  await adapter.abandon();
  assert.equal(events('bid/cancelled').length, 1, 'id-less cancel reached the adapter\'s own bid');
  assert.equal(of('op-error').length, 0, 'the whole lifecycle produced zero refusals');
});

test('holder re-bid is continuation intent: begin() during the burst window neither errors nor churns', async () => {
  const { adapter, clock, of, events } = rig();

  await adapter.begin();
  clock.advance(500);
  await adapter.speak('first message');
  clock.advance(800); // inside the burst window — grant still held

  await adapter.begin(); // composing the follow-up
  assert.equal(of('op-error').length, 0, 'no "holds a granted bid" refusal for a zero-read adapter');
  assert.equal(events('bid/replaced').length, 0, 'no phantom replacement while holding');

  clock.advance(300);
  await adapter.speak('second message, same turn');
  const outcomes = of('shadow-outcome');
  assert.deepEqual(outcomes.map((o) => o.cls), ['accept-on-speech', 'held-coalesced']);
});

test('abandon with nothing outstanding is a no-op locally; a raw id-less cancel with no bid is a ledgered refusal', async () => {
  const { core, adapter, of } = rig();

  await adapter.abandon(); // local no-op: no op line is even sent
  assert.equal(of('op').length, 0);

  // A hand-rolled adapter that cancels anyway gets an honest refusal.
  await adapter.begin();
  await adapter.speak('spends the intention');
  core.observe({
    authorId: AGENT,
    authorName: 'alpha',
    surface: 'control',
    messageId: 'stray',
    text: '!floor cancel',
    at: 60_000,
  });
  const errors = of('op-error');
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].reason), /no open bid of yours/);
});
