/**
 * MR model: as-run aggregation, replay-as-reobservation, and the agreement
 * oracle between them.
 *
 * The load-bearing test is the AGREEMENT PIN: replaying an instrument
 * ledger under its own knobs must reproduce the as-run outcome rows
 * exactly. The live core and the replay are the same class, but the pump
 * cadences differ (live ticks vs synthetic grid) — if classification ever
 * depends on cadence rather than observed time, this pin catches it. Two
 * composed instruments that both look truthful have lied to this project
 * before; the pin is the discriminator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowBidsCore } from '../trial/shadow-bids.js';
import { parseOp } from '../trial/band.js';
import {
  formatOp, parseLedger, mrReport, mrReplay, type OutcomeRow,
} from '../trial/fairness-mr.js';
import type { InboundMessage } from '../trial/transport.js';

const A = 'agent:alpha';
const B = 'agent:beta';
const H = 'user:hana';

function msg(surface: 'room' | 'control', authorId: string, at: number, text = 'hello there'): InboundMessage {
  return { authorId, authorName: authorId, surface, messageId: `m-${at}-${authorId.slice(-4)}`, text, at };
}

/** Scripted as-run session: two consenting agents, one human, real bids. */
function runScenario(opts: { burstReleaseMs?: number } = {}) {
  const rows: Record<string, unknown>[] = [];
  const core = new ShadowBidsCore('loopback://mr/room', 'loopback:test', (e) => rows.push(e), {
    consentingIds: [A, B],
    burstReleaseMs: opts.burstReleaseMs ?? 2_500,
    idleAfterMs: 60_000,
    clockGapThresholdMs: Number.MAX_SAFE_INTEGER,
    startedAt: 0,
    tickMs: 500,
  });
  // A bids, is offered, speaks (accept-on-speech), bursts once
  core.observe(msg('control', A, 500, '!floor join'));
  core.observe(msg('control', B, 600, '!floor join'));
  core.observe(msg('control', A, 1_000, '!floor bid readiness=intent'));
  core.observe(msg('room', A, 2_000));
  core.observe(msg('room', A, 3_000)); // within burst window → held-coalesced
  // human speaks — no roster row, but advances the head and rhythm
  core.observe(msg('room', H, 4_000));
  // B bids while A's burst window is still open at 5s? window: last A speech
  // 3s + 2.5s → floor frees at 5.5s under pump. B bids at 6s, offered, speaks.
  core.observe(msg('control', B, 6_000, '!floor bid readiness=intent'));
  core.observe(msg('room', B, 6_500));
  // A speaks with no bid at all → unbid
  core.observe(msg('room', A, 20_000));
  return { rows, core };
}

test('formatOp round-trips through parseOp for every band shape', () => {
  const cases = [
    '!floor bid readiness=intent',
    '!floor bid readiness=prepared subject=m-123 digest=abc expires=+30s',
    '!floor amend b3 readiness=urgent',
    '!floor cancel b7',
    '!floor ack m-99',
    '!floor continue g4 +15s',
  ];
  for (const line of cases) {
    const op = parseOp(line);
    assert.ok(op, line);
    const rebuilt = parseOp(formatOp(op.verb, op.id, op.args));
    assert.deepEqual(rebuilt, op, line);
  }
});

test('as-run aggregation: sections computed over the roster, coverage explicit', () => {
  const { rows } = runScenario();
  const report = mrReport(parseLedger(rows));

  assert.equal(report.model, 'MR');
  assert.equal(report.source, 'as-run');
  // Population: 5 room messages, 4 by roster (A×3, B×1), 1 human.
  assert.deepEqual(report.population.roster, [A, B]);
  assert.equal(report.population.totalRoomMessages, 5);
  assert.equal(report.population.rosterMessages, 4);
  assert.equal(report.population.coverage, 4 / 5);
  // Classes: A accept-on-speech + held-coalesced, B accept-on-speech, A unbid.
  assert.equal(report.classes['accept-on-speech'], 2);
  assert.equal(report.classes['held-coalesced'], 1);
  assert.equal(report.classes.unbid, 1);
  assert.equal(report.interventionRate, 1 / 4);
  // The human produced NO outcome row anywhere.
  assert.ok(report.outcomes.every((o) => o.participantId !== H));
  assert.equal(report.fairness.rosterGrants, 2);
  assert.equal(report.clockFit.burstsCoalesced, 1);
  // Knobs ride in from the run-config record, no side channel.
  assert.equal(report.knobs?.burstReleaseMs, 2_500);
});

test('AGREEMENT PIN: replay under the as-run knobs reproduces the outcome rows exactly', () => {
  const { rows } = runScenario();
  const asRun = parseLedger(rows);
  const replayed = mrReplay(asRun, {});
  const key = (o: OutcomeRow) => `${o.messageId}|${o.participantId}|${o.cls}|${o.contended}`;
  assert.deepEqual(
    replayed.report.outcomes.map(key),
    asRun.outcomes.map(key),
  );
  assert.equal(replayed.report.source, 'replay');
});

test('replay knob sweep: shrinking the burst window reclassifies the coalesced message', () => {
  const { rows } = runScenario();
  const asRun = parseLedger(rows);
  // Burst window under the 1 s gap between A's two messages: the second
  // message is no longer a continuation. The floor freed after message one,
  // A holds no bid (spent), so the second message classifies as unbid.
  const swept = mrReplay(asRun, { burstReleaseMs: 500 });
  assert.equal(swept.report.classes['held-coalesced'], 0);
  assert.ok(swept.report.classes.unbid >= 2, JSON.stringify(swept.report.classes));
  // And the sweep is deterministic: same overrides, same rows.
  const again = mrReplay(asRun, { burstReleaseMs: 500 });
  assert.deepEqual(again.report.classes, swept.report.classes);
});

test('replay refuses a config-less ledger; report falls back to inferred roster', () => {
  const { rows } = runScenario();
  const stripped = rows.filter((r) => r.kind !== 'run-config');
  const ledger = parseLedger(stripped);
  assert.throws(() => mrReplay(ledger, {}), /run-config/);
  const report = mrReport(ledger);
  assert.deepEqual(report.population.roster, [A, B]); // inferred from op/outcome rows
});

test('two runs in one file refuse to aggregate', () => {
  const { rows: r1 } = runScenario();
  const { rows: r2 } = runScenario();
  assert.throws(() => parseLedger([...r1, ...r2]), /run-config records/);
});
