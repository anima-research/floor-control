/**
 * Shadow-bids conformance (stage 0b, real-shadow-bids form — rev 9):
 * consenting agents place GENUINE bids into a real book that grants
 * nothing. Pins, in order:
 *   1. zero-send as executable evidence, 0a discipline inherited — the
 *      full counterfactual lifecycle (ops in, offers issued, expiries,
 *      idle epochs, shutdown) produces zero room/control sends;
 *   2. the counterfactual lifecycle itself (offer → accept-on-speech →
 *      burst coalescing → burst-end release), ledgered not emitted;
 *   3. consent gating: non-consenting ops are refused with args dropped,
 *      non-consenting speech gets rhythm rows but never an outcome row;
 *   4. the outcome taxonomy against real bids: post-expiry via the book's
 *      own ignored-offer streak, blocked discharging the spent bid;
 *   5. grant-directed ops have no shadow analog and say so;
 *   6. §9: no record field carries message text.
 * Mutation control: adding any send to startShadowBids/ShadowBidsCore
 * turns test 1 red; ledgering non-consenting outcomes turns test 3 red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { InboundMessage, RoomTransport } from '../trial/transport.js';
import { ShadowBidsCore, startShadowBids } from '../trial/shadow-bids.js';

const AGENT_A = 'persona:alpha';
const AGENT_B = 'persona:beta';
const HUMAN = 'user:1';

function msg(
  authorId: string,
  surface: 'room' | 'control',
  text: string,
  at: number,
  id?: string,
): InboundMessage {
  return {
    authorId,
    authorName: authorId.split(':')[1] ?? authorId,
    surface,
    messageId: id ?? `m-${at}-${authorId.slice(-4)}`,
    text,
    at,
  };
}

function makeCore(opts?: { consentingIds?: string[]; burstReleaseMs?: number; idleAfterMs?: number }) {
  const records: Record<string, unknown>[] = [];
  const core = new ShadowBidsCore(
    'loopback://test/room-1',
    'loopback:test',
    (e) => records.push(e),
    {
      consentingIds: opts?.consentingIds ?? [AGENT_A, AGENT_B],
      burstReleaseMs: opts?.burstReleaseMs ?? 2_500,
      idleAfterMs: opts?.idleAfterMs ?? 60_000,
      clockGapThresholdMs: Number.MAX_SAFE_INTEGER, // deterministic tests drive time by hand
      startedAt: 0,
    },
  );
  const of = (kind: string) => records.filter((r) => r.kind === kind);
  const events = (type: string) => of('event').filter((r) => r.type === type);
  return { core, records, of, events };
}

test('zero-send: the full counterfactual lifecycle through the injectable seam produces no room/control sends', async () => {
  const sends: string[] = [];
  let handler: ((m: InboundMessage) => void) | undefined;
  let closes = 0;
  const spy: RoomTransport = {
    locator: 'spy://trial/room-1',
    provenance: 'spy:test',
    onMessage(h) {
      handler = h;
    },
    async sendRoom(text) {
      sends.push(`room:${text}`);
      return 'sent';
    },
    async sendControl(text) {
      sends.push(`control:${text}`);
      return 'sent';
    },
    async close() {
      closes += 1;
    },
  };

  const records: Record<string, unknown>[] = [];
  const t0 = Date.now();
  const shadow = startShadowBids(spy, (e) => records.push(e), {
    consentingIds: [AGENT_A],
    tickMs: 3_600_000, // the test drives all pumps through inbound traffic
  });
  assert.ok(handler, 'the core subscribed to inbound traffic');

  // Every op family + speech on both surfaces, including lines that
  // provoke replies from a live arbiter (join notice, bid/accepted,
  // error events, offers with mentions) — the shadow answers none.
  handler!(msg(AGENT_A, 'control', '!floor join', t0));
  handler!(msg(AGENT_A, 'control', '!floor bid readiness=prepared', t0 + 100));
  handler!(msg(AGENT_A, 'control', '!floor accept g1', t0 + 200)); // refused: no shadow analog
  handler!(msg(HUMAN, 'control', '!floor bid readiness=intent', t0 + 300)); // refused: unconsented
  handler!(msg(HUMAN, 'room', 'a human sentence', t0 + 400));
  handler!(msg(AGENT_A, 'room', 'agent speech consuming its would-be grant', t0 + 500));
  await shadow.stop();

  assert.equal(sends.length, 0, 'zero room/control sends across the whole lifecycle and shutdown');
  assert.equal(closes, 1, 'shutdown closes the transport');
  assert.ok(records.some((r) => r.kind === 'event' && r.type === 'grant/offered'), 'the book really arbitrated');
});

test('counterfactual lifecycle: offer ledgered with head, accept-on-speech, burst coalescing, burst-end release', () => {
  const { core, of, events } = makeCore();
  let now = 1_000;

  core.observe(msg(HUMAN, 'room', 'ambient speech', (now += 100), 'head-1'));
  core.observe(msg(AGENT_A, 'control', '!floor join', (now += 100)));
  core.observe(msg(AGENT_A, 'control', '!floor bid readiness=prepared', (now += 100)));

  const offered = events('grant/offered');
  assert.equal(offered.length, 1, 'the logic offered against the real bid');
  assert.equal(offered[0].head, 'head-1', 'the offer is stamped with the real room head');

  // The bidder speaks: acceptance evidence, classified concordant.
  core.observe(msg(AGENT_A, 'room', 'first message of the burst', (now += 500)));
  assert.equal(events('grant/accepted').length, 1, 'speech accepted the standing offer');
  let outcomes = of('shadow-outcome');
  assert.deepEqual(outcomes.map((o) => o.cls), ['accept-on-speech']);

  // Self-continuation inside the burst window extends the hold.
  core.observe(msg(AGENT_A, 'room', 'second message, same turn', (now += 800)));
  outcomes = of('shadow-outcome');
  assert.deepEqual(outcomes.map((o) => o.cls), ['accept-on-speech', 'held-coalesced']);
  assert.equal(events('grant/released').length, 0, 'still inside the burst window');

  // Burst-end: the pump releases, exactly as the adapter's atomic op would.
  core.pump(now + 3_000);
  assert.equal(events('grant/released').length, 1, 'burst-end released the counterfactual grant');
});

test('consent gating: ops refused with args dropped; speech ledgers rhythm but never an outcome row', () => {
  const { core, of } = makeCore({ consentingIds: [AGENT_A] });

  core.observe(msg(HUMAN, 'control', '!floor bid readiness=intent subject=secret-ref', 1_000));
  const refused = of('op-unconsented');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].op, 'bid');
  assert.equal('args' in refused[0], false, 'minimization: the refused op keeps its verb, drops its args');
  assert.equal(core.book.listBids().length, 0, 'no book entry for a non-consenting party');

  core.observe(msg(HUMAN, 'room', 'ordinary human speech', 2_000));
  assert.equal(of('speech-rhythm').length, 2, 'rhythm rows for everyone (0a product intact)');
  assert.equal(of('shadow-outcome').length, 0, 'no fairness row about someone who did not opt in');
});

test('post-expiry: an offer the bidder never saw expires, and their late speech is classified honestly', () => {
  const { core, of, events } = makeCore();
  let now = 1_000;

  core.observe(msg(AGENT_A, 'control', '!floor join', (now += 100)));
  core.observe(msg(AGENT_A, 'control', '!floor bid readiness=prepared', (now += 100)));
  assert.equal(events('grant/offered').length, 1);

  // The prepared accept-TTL (15 s) elapses with nobody told — tick expires
  // the offer and the book charges the streak.
  core.pump((now += 20_000));
  assert.equal(events('grant/offer-expired').length, 1);

  // The bidder finally speaks: C2 mismatch, real-bid edition.
  core.observe(msg(AGENT_A, 'room', 'too late to be the granted turn', (now += 100)));
  const outcomes = of('shadow-outcome');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].cls, 'post-expiry');
  assert.equal(
    core.book.listBids().some((b) => b.participantId === AGENT_A && b.state === 'open'),
    false,
    'the spent intention was discharged',
  );
});

test('blocked: speech during another holder\'s counterfactual grant is ledgered and discharges the spent bid', () => {
  const { core, of, events } = makeCore({ burstReleaseMs: 60_000 });
  let now = 1_000;

  for (const agent of [AGENT_A, AGENT_B]) {
    core.observe(msg(agent, 'control', '!floor join', (now += 100)));
  }
  core.observe(msg(AGENT_A, 'control', '!floor bid readiness=prepared', (now += 100)));
  core.observe(msg(AGENT_A, 'room', 'alpha takes its would-be turn', (now += 200)));
  assert.equal(events('grant/accepted').length, 1);

  core.observe(msg(AGENT_B, 'control', '!floor bid readiness=prepared', (now += 100)));
  core.observe(msg(AGENT_B, 'room', 'beta speaks through alpha\'s hold', (now += 500)));

  const outcomes = of('shadow-outcome');
  assert.deepEqual(
    outcomes.map((o) => [o.participantId, o.cls]),
    [
      [AGENT_A, 'accept-on-speech'],
      [AGENT_B, 'blocked'],
    ],
  );
  assert.equal(outcomes[1].holder, AGENT_A);
  assert.equal(outcomes[1].contended, true, 'a 500 ms handoff is inside the contention window');
  assert.equal(
    core.book.listBids().some((b) => b.participantId === AGENT_B && b.state === 'open'),
    false,
    'beta\'s spent bid was discharged, the book otherwise untouched',
  );
  assert.equal(core.book.liveGrant?.participantId, AGENT_A, 'alpha still holds the counterfactual floor');
});

test('grant-directed ops have no shadow analog and the refusal says so', () => {
  const { core, of } = makeCore();
  core.observe(msg(AGENT_A, 'control', '!floor join', 1_000));
  for (const line of ['!floor accept g1', '!floor decline g1', '!floor release g1', '!floor continue g1 +15s']) {
    core.observe(msg(AGENT_A, 'control', line, 2_000));
  }
  const errors = of('op-error');
  assert.equal(errors.length, 4);
  for (const e of errors) assert.match(String(e.reason), /no shadow analog/);
});

test('idle epochs are ledgered, never emitted; §9 holds across every record', () => {
  const { core, of, records } = makeCore({ idleAfterMs: 5_000 });
  core.observe(msg(HUMAN, 'room', 'the last thing said before the quiet', 1_000));
  core.pump(10_000);
  assert.equal(of('idle').length, 1, 'a quiet epoch is data');

  core.observe(msg(AGENT_A, 'control', '!floor join', 11_000));
  core.observe(msg(AGENT_A, 'control', '!floor bid readiness=prepared subject=head-x digest=abc123', 11_100));
  core.observe(msg(AGENT_A, 'room', 'speech that consumes the would-be grant', 11_600));
  for (const r of records) {
    assert.equal(
      Object.values(r).some(
        (v) => typeof v === 'string' && /last thing said|consumes the would-be/.test(v),
      ),
      false,
      `no record field carries message text: ${JSON.stringify(r)}`,
    );
  }
});

test('an instrument with no consenting participants refuses to run (that is stage 0a)', () => {
  assert.throws(
    () =>
      new ShadowBidsCore('loopback://x', 'loopback:test', () => {}, { consentingIds: [] }),
    /run stage 0a/,
  );
});
