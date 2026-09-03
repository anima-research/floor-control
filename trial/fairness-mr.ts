/**
 * MR — the measured-real rung of the fairness-diff honesty ladder.
 *
 * The design doc's models in ascending honesty: M0 (bid-at-send, null),
 * M1 (δ-synthesis, sensitivity-fragile — the δ-sweep showed a 14× swing on
 * one free parameter), M2 (typing-gesture, future). MR sits above M1 and
 * beside M2: bids here were REAL — consenting agents' `!floor bid` ops,
 * recorded by the 0b instrument before the speech they preceded. No
 * synthesis fiction anywhere in the book, for the roster half of the room.
 *
 * Two capabilities over one aggregator:
 *
 *  - AS-RUN: the instrument already arbitrated live and ledgered the
 *    counterfactual grant stream beside the room's real speech. Its ledger
 *    IS the outcome stream; this module folds it into the fairness-diff
 *    report sections.
 *
 *  - REPLAY: re-observe the recorded stream through a fresh ShadowBidsCore
 *    under overridden knobs — the tuning loop with zero synthesis. Replay
 *    is RE-OBSERVATION, not a second engine: the core is a pure function
 *    of observed time (its clocks seed lazily from the stream), so the
 *    same class that classified live classifies offline, and the as-run
 *    ledger doubles as a conformance oracle — same knobs in, same outcome
 *    rows out, or one of the two is wrong. (Two instruments composed have
 *    lied to this project before; agreement checks are load-bearing.)
 *
 * POPULATION HONESTY (the §9 posture, aggregated): outcome rows exist only
 * for the consenting roster, so every report carries an explicit population
 * block and denominates its sections over ROSTER speech, never silently
 * over the room. Room-wide numbers appear only where the underlying data
 * is room-wide public-shape (organic concentration from rhythm rows), and
 * the fairness section compares roster-only against roster-only.
 *
 * Replay clock fidelity: live runs pump on a tick cadence; replay pumps at
 * every observation plus synthetic ticks on the run's own tickMs grid
 * (skipped while the book is empty — they could not change state). Under
 * identical knobs this reproduces the live classification; under swept
 * knobs it is the same fidelity for every point of the sweep, which is
 * what a sweep needs.
 */

import { ShadowBidsCore, type ShadowSpeechClass } from './shadow-bids.js';
import type { FloorOp } from './band.js';
import type { InboundMessage } from './transport.js';

// ── Ledger row shapes (the instrument's record kinds, typed) ───────────────

export interface RunConfigRow {
  kind: 'run-config';
  at: number;
  locator: string;
  provenance: string;
  consentingIds: string[];
  knobs: {
    tickMs: number;
    burstReleaseMs: number;
    contentionWindowMs: number;
    idleAfterMs: number;
    clockGapThresholdMs: number | null;
  };
}

export interface OutcomeRow {
  kind: 'shadow-outcome';
  at: number;
  participantId: string;
  messageId: string;
  cls: ShadowSpeechClass;
  contended: boolean;
}

export interface RhythmRow {
  kind: 'speech-rhythm';
  at: number;
  authorId: string;
  messageId: string;
  bytes: number;
  surface: 'room' | 'control';
}

export interface EventRow {
  kind: 'event';
  type: string;
  at: number;
  participantId?: string;
}

export interface OpRow {
  kind: 'op';
  at: number;
  participantId: string;
  op: FloorOp['verb'];
  id?: string;
  args: Record<string, string>;
}

export interface MrLedger {
  config: RunConfigRow | null;
  rows: Record<string, unknown>[];
  outcomes: OutcomeRow[];
  roomSpeech: RhythmRow[];
  events: EventRow[];
  idleCount: number;
  clockGapCount: number;
}

export function parseLedger(rows: Record<string, unknown>[]): MrLedger {
  const configs = rows.filter((r) => r.kind === 'run-config') as unknown as RunConfigRow[];
  if (configs.length > 1) {
    // Two runs in one file would aggregate under whichever config parsed
    // first and silently misdescribe the other — refuse rather than blend.
    throw new Error(`ledger contains ${configs.length} run-config records — split runs before aggregating`);
  }
  return {
    config: configs[0] ?? null,
    rows,
    outcomes: rows.filter((r) => r.kind === 'shadow-outcome') as unknown as OutcomeRow[],
    roomSpeech: rows.filter((r) => r.kind === 'speech-rhythm' && r.surface === 'room') as unknown as RhythmRow[],
    events: rows.filter((r) => r.kind === 'event') as unknown as EventRow[],
    idleCount: rows.filter((r) => r.kind === 'idle').length,
    clockGapCount: rows.filter((r) => r.kind === 'clock-gap').length,
  };
}

export function parseLedgerLines(jsonl: string): MrLedger {
  return parseLedger(
    jsonl
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

// ── Op round-trip (replay reconstruction) ──────────────────────────────────

/** Inverse of band.ts's parseOp, for replaying ledgered ops: the ledger
 *  keeps verb/id/args, not the original line. Round-trip pinned by test —
 *  `parseOp(formatOp(x))` must reproduce x for every shape the band
 *  grammar admits. `extend` re-renders as the bare `+15s` token. */
export function formatOp(verb: string, id: string | undefined, args: Record<string, string>): string {
  const parts = [`!floor ${verb}`];
  if (id) parts.push(id);
  for (const [k, v] of Object.entries(args)) {
    if (k === 'extend') parts.push(v.startsWith('+') ? v : `+${v}`);
    else parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}

// ── The report ─────────────────────────────────────────────────────────────

const ALL_CLASSES: ShadowSpeechClass[] = [
  'held-coalesced', 'accept-on-speech', 'blocked', 'unoffered', 'post-expiry', 'unbid',
];
const INTERVENTION_CLASSES: ShadowSpeechClass[] = ['blocked', 'unoffered', 'post-expiry', 'unbid'];

export interface MrReport {
  model: 'MR';
  source: 'as-run' | 'replay';
  knobs: RunConfigRow['knobs'] | null;
  /** The honesty block: what fraction of the room the numbers describe. */
  population: {
    roster: string[];
    rosterMessages: number;
    totalRoomMessages: number;
    /** rosterMessages / totalRoomMessages — an intervention rate over
     *  three consenting agents in a twenty-person room must say so. */
    coverage: number;
  };
  classes: Record<ShadowSpeechClass, number>;
  /** Over ROSTER speech only (see population.coverage). */
  interventionRate: number;
  contention: {
    contendedRosterMessages: number;
    interventionRateContended: number;
    interventionRateUncontended: number;
  };
  concordance: {
    offersIssued: number;
    offerExpiries: number;
    leaseExpiries: number;
    /** Offers whose recipient was not the room's next actual speaker. */
    mismatchedOffers: number;
  };
  fairness: {
    /** Room-wide organic concentration — rhythm rows are public-shape. */
    roomTopAuthorMessageShare: number;
    /** Roster-only, like-for-like: grants exist only for the roster. */
    rosterTopAuthorMessageShare: number;
    rosterTopAuthorGrantShare: number;
    rosterGrants: number;
  };
  clockFit: {
    idleEpochs: number;
    clockGaps: number;
    burstsCoalesced: number;
    offerExpiries: number;
  };
  /** Per-identity rows — LOCAL LEDGER ONLY per the design doc's privacy
   *  posture: never printed in the public aggregate, shared only with the
   *  named participant on ask. */
  perIdentity: Record<string, { messages: number; grants: number; interventions: number }>;
  outcomes: OutcomeRow[];
}

export function mrReport(ledger: MrLedger, source: MrReport['source'] = 'as-run'): MrReport {
  const roster = ledger.config?.consentingIds ?? inferRoster(ledger);
  const rosterSet = new Set(roster);
  const rosterSpeech = ledger.roomSpeech.filter((r) => rosterSet.has(r.authorId));

  const classes = Object.fromEntries(ALL_CLASSES.map((c) => [c, 0])) as Record<ShadowSpeechClass, number>;
  for (const o of ledger.outcomes) classes[o.cls] = (classes[o.cls] ?? 0) + 1;
  const interventions = INTERVENTION_CLASSES.reduce((n, c) => n + classes[c], 0);

  const contendedRows = ledger.outcomes.filter((o) => o.contended);
  const contendedInterventions = contendedRows.filter((o) => INTERVENTION_CLASSES.includes(o.cls)).length;
  const uncontendedRows = ledger.outcomes.length - contendedRows.length;
  const uncontendedInterventions = interventions - contendedInterventions;

  const offers = ledger.events.filter((e) => e.type === 'grant/offered');
  const offerExpiries = ledger.events.filter((e) => e.type === 'grant/offer-expired').length;
  const leaseExpiries = ledger.events.filter((e) => e.type === 'grant/lease-expired').length;
  // Concordance: for each offer, was its recipient the next room speaker?
  const speechAsc = [...ledger.roomSpeech].sort((a, b) => a.at - b.at);
  let mismatchedOffers = 0;
  for (const off of offers) {
    const next = speechAsc.find((s) => s.at >= off.at);
    if (next && next.authorId !== off.participantId) mismatchedOffers += 1;
  }

  const byAuthor = (rows: { authorId?: string; participantId?: string }[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const id = (r.authorId ?? r.participantId)!;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  };
  const share = (m: Map<string, number>): number => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return total === 0 ? 0 : Math.max(...m.values()) / total;
  };
  const grantRows = ledger.outcomes.filter((o) => o.cls === 'accept-on-speech');
  const grantsByAuthor = byAuthor(grantRows);

  const perIdentity: MrReport['perIdentity'] = {};
  for (const id of roster) {
    const mine = ledger.outcomes.filter((o) => o.participantId === id);
    perIdentity[id] = {
      messages: rosterSpeech.filter((s) => s.authorId === id).length,
      grants: mine.filter((o) => o.cls === 'accept-on-speech').length,
      interventions: mine.filter((o) => INTERVENTION_CLASSES.includes(o.cls)).length,
    };
  }

  return {
    model: 'MR',
    source,
    knobs: ledger.config?.knobs ?? null,
    population: {
      roster,
      rosterMessages: rosterSpeech.length,
      totalRoomMessages: ledger.roomSpeech.length,
      coverage: ledger.roomSpeech.length === 0 ? 0 : rosterSpeech.length / ledger.roomSpeech.length,
    },
    classes,
    interventionRate: ledger.outcomes.length === 0 ? 0 : interventions / ledger.outcomes.length,
    contention: {
      contendedRosterMessages: contendedRows.length,
      interventionRateContended: contendedRows.length === 0 ? 0 : contendedInterventions / contendedRows.length,
      interventionRateUncontended: uncontendedRows === 0 ? 0 : uncontendedInterventions / uncontendedRows,
    },
    concordance: { offersIssued: offers.length, offerExpiries, leaseExpiries, mismatchedOffers },
    fairness: {
      roomTopAuthorMessageShare: share(byAuthor(ledger.roomSpeech)),
      rosterTopAuthorMessageShare: share(byAuthor(rosterSpeech)),
      rosterTopAuthorGrantShare: share(grantsByAuthor),
      rosterGrants: grantRows.length,
    },
    clockFit: {
      idleEpochs: ledger.idleCount,
      clockGaps: ledger.clockGapCount,
      burstsCoalesced: classes['held-coalesced'],
      offerExpiries,
    },
    perIdentity,
    outcomes: ledger.outcomes,
  };
}

/** Fallback when a ledger predates run-config: the roster is inferable
 *  from who has outcome/op rows (an under-approximation — a consenting
 *  participant who never bid and never spoke is invisible). The report
 *  can't tell the difference, which is exactly why run-config exists. */
function inferRoster(ledger: MrLedger): string[] {
  const ids = new Set<string>();
  for (const o of ledger.outcomes) ids.add(o.participantId);
  for (const r of ledger.rows) if (r.kind === 'op') ids.add((r as unknown as OpRow).participantId);
  return [...ids].sort();
}

// ── Replay: re-observation under overridden knobs ──────────────────────────

export interface MrReplayResult {
  report: MrReport;
  /** The fresh ledger the re-observation produced (outcome rows compare
   *  against the as-run ledger's — the agreement oracle). */
  rows: Record<string, unknown>[];
}

export function mrReplay(
  asRun: MrLedger,
  knobOverrides: Partial<RunConfigRow['knobs']> = {},
): MrReplayResult {
  const cfg = asRun.config;
  if (!cfg) throw new Error('replay needs a run-config record (older ledgers: re-run the instrument, or aggregate as-run only)');
  const knobs = { ...cfg.knobs, ...knobOverrides };

  // Reconstruct the observed stream from the ledger, in ledger order (the
  // recorder writes a rhythm row for every message before any op row, so
  // ledger order IS arrival order; an op row patches the text of the
  // control message just emitted).
  const stream: InboundMessage[] = [];
  for (const row of asRun.rows) {
    if (row.kind === 'speech-rhythm') {
      const r = row as unknown as RhythmRow;
      stream.push({
        authorId: r.authorId,
        authorName: r.authorId,
        surface: r.surface,
        messageId: r.messageId,
        // Content never survives the §9 ledger; byte length does, and the
        // recorder's rhythm rows are the only consumer of text length.
        text: 'x'.repeat(Math.max(0, r.bytes)),
        at: r.at,
      });
    } else if (row.kind === 'op') {
      const r = row as unknown as OpRow;
      const last = stream[stream.length - 1];
      if (last && last.surface === 'control' && last.authorId === r.participantId) {
        last.text = formatOp(r.op, r.id, r.args ?? {});
      }
    }
    // op-unconsented rows stay unreconstructed on purpose: their args were
    // dropped at the record boundary and the book never saw them; replaying
    // their rhythm row (already emitted) preserves everything they affect.
  }

  const rows: Record<string, unknown>[] = [];
  const core = new ShadowBidsCore(cfg.locator, cfg.provenance, (e) => rows.push(e), {
    consentingIds: cfg.consentingIds,
    tickMs: knobs.tickMs,
    burstReleaseMs: knobs.burstReleaseMs,
    contentionWindowMs: knobs.contentionWindowMs,
    idleAfterMs: knobs.idleAfterMs,
    // Replay time is stream time; a wall-clock gap detector has no meaning.
    clockGapThresholdMs: Number.MAX_SAFE_INTEGER,
    startedAt: cfg.at,
  });

  // Never core.start(): no timers in a replay. The live tick cadence is
  // reproduced deterministically — synthetic pumps on the run's own tickMs
  // grid between observations, skipped while the book holds nothing a
  // pump could change.
  let clock = cfg.at;
  for (const m of stream) {
    for (let t = clock + knobs.tickMs; t < m.at; t += knobs.tickMs) {
      if (core.book.openBids().length || core.book.liveGrant) core.pump(t);
    }
    core.observe(m);
    clock = m.at;
  }

  return { report: mrReport(parseLedger(rows), 'replay'), rows };
}
