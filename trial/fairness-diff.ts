/**
 * Shadow pass 2 — the hypothetical-bid fairness-diff (design doc
 * 2026-08-25; RFC rev 9 §12 companion).
 *
 * Replays a rhythm record stream (the §9-audited shape: timestamps,
 * author ids, byte counts — no content) through the real book + logic in
 * loopback, and ledgers what the floor WOULD have decided beside what the
 * room actually did. Deterministic: pure function of (records, knobs);
 * the library never reads a clock, and neither does this.
 *
 * The counterfactual is not causal. The observed room is the no-floor
 * equilibrium; this measures the decision procedure's DISAGREEMENT with
 * it, not what a managed room would feel like. Bids here are synthesized
 * (M0/M1 — fictions about when authors wanted the floor, see the design
 * doc's honesty section); results are rig-shakedown and null-model
 * baselines until live-gesture bids (M2) exist.
 *
 * Modeling choices, each traceable to a ruling:
 * - Acceptance is accept-on-speech for every participant: observed speech
 *   is the acceptance evidence (§6 native-gesture model applied to
 *   replay). Offer TTLs still bind — a participant whose offer expired
 *   before they spoke shows up as exactly the C2 mismatch the instrument
 *   exists to measure. Lease expiries are structurally absent under this
 *   model; revisit at M2.
 * - Burst coalescing applies to agent leases only (C3: humans have no
 *   timer-detectable burst boundary). An agent's grant holds for
 *   burstReleaseMs after each message; a human's grant releases on emit.
 * - Violations never mutate the book (voluntary compliance): the speech
 *   happened, the ledger records the disagreement, the discharged bid is
 *   cancelled (the intention was spent out-of-band).
 */

import { FloorService } from '../src/service.js';
import { FluidFairnessLogic } from '../src/logics.js';
import type { FloorBook } from '../src/book.js';

export interface RhythmRecord {
  at: number;
  authorId: string;
  messageId: string;
  bytes: number;
  inThread?: boolean;
}

export type BidModel = 'M0' | 'M1';
export type ParticipantKind = 'human' | 'agent';

export interface ReplayKnobs {
  model: BidModel;
  /** Agent-lease burst hold (rev 9 §6). MUST NOT apply to humans — and
   *  structurally cannot here: human grants release on emit. */
  burstReleaseMs: number;
  /** A speech act is "contended" when it follows a different author within
   *  this window (harvest p10 handoff ≈ 16.5 s; default 5 s per the doc). */
  contentionWindowMs: number;
  /** Quiet-epoch threshold for the clock-fit section (C1). */
  idleAfterMs: number;
  /** M1: agent bid lead time before send (harness turnaround). */
  deltaAgentMs: number;
  /** M1: human composition-time proxy — bytes ÷ this = seconds typing. */
  humanBytesPerSec: number;
  deltaHumanMinMs: number;
  deltaHumanCapMs: number;
  speechLeaseMs: number;
}

export const DEFAULT_KNOBS: ReplayKnobs = {
  model: 'M0',
  burstReleaseMs: 2_500,
  contentionWindowMs: 5_000,
  idleAfterMs: 60_000,
  deltaAgentMs: 1_000,
  humanBytesPerSec: 6,
  deltaHumanMinMs: 2_000,
  deltaHumanCapMs: 120_000,
  speechLeaseMs: 30_000,
};

export function kindOf(authorId: string): ParticipantKind {
  return authorId.startsWith('user:') ? 'human' : 'agent';
}

export type SpeechClass =
  /** Speaker already held the accepted grant (agent burst continuation). */
  | 'held-coalesced'
  /** Speaker held a live offer and speech accepted it (the concordant
   *  common case under accept-on-speech). */
  | 'accept-on-speech'
  /** Someone else held the floor at speech time. */
  | 'blocked'
  /** Floor free, speaker's bid open, but the logic had not offered —
   *  arbitration gap (typically backoff downranking after an expiry). */
  | 'unoffered'
  /** The speaker's offer expired before they spoke (the C2 mismatch). */
  | 'post-expiry'
  /** Speaker had no live bid at speech time (post-lapse, or a
   *  discharged-then-silent edge). */
  | 'unbid';

export interface SpeechOutcome {
  messageId: string;
  at: number;
  authorId: string;
  kind: ParticipantKind;
  cls: SpeechClass;
  contended: boolean;
}

export interface FairnessDiffReport {
  knobs: ReplayKnobs;
  messages: number;
  byKind: Record<ParticipantKind, number>;
  classes: Record<SpeechClass, number>;
  /** blocked + unoffered + post-expiry + unbid over all messages. */
  interventionRate: number;
  interventionByKind: Record<ParticipantKind, number>;
  contention: {
    contendedMessages: number;
    interventionRateContended: number;
    interventionRateUncontended: number;
  };
  concordance: {
    offersIssued: number;
    /** Offers whose recipient was not the room's next actual speaker. */
    mismatchedOffers: number;
    offerExpiries: number;
    lapses: number;
  };
  fairness: {
    topAuthorMessageShare: number;
    topAuthorGrantShare: number;
    byKind: Record<ParticipantKind, { messages: number; grants: number }>;
  };
  clockFit: {
    quietEpochs: number;
    burstsCoalesced: number;
    offerExpiries: number;
    /** Always 0 under accept-on-speech; present so the report says so. */
    leaseExpiries: number;
  };
  /** Per-identity rows — LOCAL LEDGER ONLY per the design doc's privacy
   *  posture: never printed in the public aggregate, shared only with the
   *  named participant on ask. */
  perIdentity: Record<string, {
    kind: ParticipantKind;
    messages: number;
    grants: number;
    violations: number;
    offerExpiries: number;
  }>;
  outcomes: SpeechOutcome[];
}

interface ReplayEvent {
  t: number;
  /** bids sort before speech at equal t. */
  rank: 0 | 1;
  idx: number;
  type: 'bid' | 'speech';
  rec: RhythmRecord;
}

export function synthesizeBidAt(rec: RhythmRecord, prevAtSameAuthor: number | undefined, knobs: ReplayKnobs): number {
  if (knobs.model === 'M0') return rec.at;
  const kind = kindOf(rec.authorId);
  const delta = kind === 'agent'
    ? knobs.deltaAgentMs
    : Math.min(knobs.deltaHumanCapMs, Math.max(knobs.deltaHumanMinMs, (rec.bytes / knobs.humanBytesPerSec) * 1000));
  const floor = prevAtSameAuthor !== undefined ? prevAtSameAuthor + 1 : -Infinity;
  return Math.max(floor, rec.at - delta);
}

export function replay(rawRecords: RhythmRecord[], overrides: Partial<ReplayKnobs> = {}): FairnessDiffReport {
  const knobs: ReplayKnobs = { ...DEFAULT_KNOBS, ...overrides };
  const records = rawRecords
    .filter((r) => !r.inThread)
    .slice()
    .sort((a, b) => a.at - b.at);

  // ── Synthesize the bid stream ──
  const events: ReplayEvent[] = [];
  const prevAtByAuthor = new Map<string, number>();
  records.forEach((rec, idx) => {
    const bidAt = synthesizeBidAt(rec, prevAtByAuthor.get(rec.authorId), knobs);
    events.push({ t: bidAt, rank: 0, idx, type: 'bid', rec });
    events.push({ t: rec.at, rank: 1, idx, type: 'speech', rec });
    prevAtByAuthor.set(rec.authorId, rec.at);
  });
  events.sort((a, b) => a.t - b.t || a.rank - b.rank || a.idx - b.idx);

  // ── Loopback service ──
  const service = new FloorService('replay-epoch');
  const logic = new FluidFairnessLogic({ speechLeaseMs: knobs.speechLeaseMs });
  const t0 = events.length ? events[0].t : 0;
  const room = service.registerRoom('replay://records', 'fairness-diff-replay', logic, t0 - 1);
  const book: FloorBook = room.book;

  // ── Engine state ──
  let bidCounter = 0;
  const openBidByAuthor = new Map<string, string>();
  const lastOfferGrantByBid = new Map<string, string>();
  const offersIssued: { grantId: string; participantId: string; at: number; afterIdx: number }[] = [];
  let pendingRelease: { t: number; grantId: string } | null = null;
  const outcomes: SpeechOutcome[] = [];
  let prevSpeech: RhythmRecord | null = null;
  let nextEventIdxForOffers = 0;

  const pump = (t: number): void => {
    const { grant } = service.arbitrate(room.roomId, t);
    if (grant) {
      offersIssued.push({ grantId: grant.grantId, participantId: grant.participantId, at: t, afterIdx: nextEventIdxForOffers });
      lastOfferGrantByBid.set(grant.bidId, grant.grantId);
    }
  };

  const scheduleTurnEnd = (t: number, grantId: string, kind: ParticipantKind): void => {
    if (kind === 'agent') {
      pendingRelease = { t: t + knobs.burstReleaseMs, grantId };
    } else {
      // C3: a human turn is one message; the burst timer must not apply.
      service.release(room.roomId, grantId, t);
      pendingRelease = null;
      pump(t);
    }
  };

  const flushRelease = (): void => {
    if (!pendingRelease) return;
    const { t, grantId } = pendingRelease;
    pendingRelease = null;
    // The grant may already be terminal (lease-expired under a long gap).
    if (book.liveGrant?.grantId === grantId) {
      service.release(room.roomId, grantId, t);
      pump(t);
    }
  };

  let i = 0;
  while (i < events.length || pendingRelease) {
    if (pendingRelease && (i >= events.length || pendingRelease.t <= events[i].t)) {
      flushRelease();
      continue;
    }
    const ev = events[i++];
    nextEventIdxForOffers = ev.idx;
    const author = ev.rec.authorId;
    const kind = kindOf(author);

    if (ev.type === 'bid') {
      // Skip while holding: a granted participant does not rebid (§2.2 —
      // createBid would refuse); the burst path covers their next message.
      if (book.liveGrant?.participantId === author) continue;
      const existing = openBidByAuthor.get(author);
      if (existing && book.openBids().some((b) => b.bidId === existing)) continue;
      const bidId = `b${++bidCounter}`;
      book.createBid(
        {
          participantId: author,
          bidId,
          createdAt: ev.t,
          expiresAt: null,
          readinessKind: kind === 'human' ? 'manual' : 'intent',
        },
        ev.t,
      );
      openBidByAuthor.set(author, bidId);
      pump(ev.t);
      continue;
    }

    // ── speech ──
    const t = ev.t;
    pump(t); // tick: expire overdue offers before judging this speech
    const live = book.liveGrant;
    const contended = prevSpeech !== null
      && prevSpeech.authorId !== author
      && t - prevSpeech.at < knobs.contentionWindowMs;

    let cls: SpeechClass;
    if (live && live.participantId === author && live.state === 'accepted') {
      cls = 'held-coalesced';
      if (kind === 'agent' && pendingRelease?.grantId === live.grantId) {
        pendingRelease = { t: t + knobs.burstReleaseMs, grantId: live.grantId };
      } else {
        scheduleTurnEnd(t, live.grantId, kind);
      }
    } else if (live && live.participantId === author && live.state === 'offered') {
      service.accept(room.roomId, live.grantId, t);
      cls = 'accept-on-speech';
      scheduleTurnEnd(t, live.grantId, kind);
    } else {
      const bidId = openBidByAuthor.get(author);
      const openBid = bidId ? book.openBids().find((b) => b.bidId === bidId) : undefined;
      if (live && live.participantId !== author) {
        cls = 'blocked';
      } else if (openBid) {
        const lastOffer = lastOfferGrantByBid.get(openBid.bidId);
        cls = lastOffer && book.receiptFor(lastOffer)?.terminal === 'offer-expired'
          ? 'post-expiry'
          : 'unoffered';
      } else {
        cls = 'unbid';
      }
      // Discharge: the intention was spent out-of-band (voluntary
      // compliance — the book records disagreement, never resists it).
      if (openBid) {
        book.cancelBid(openBid.bidId, t);
        openBidByAuthor.delete(author);
        pump(t);
      }
    }

    book.noteHead(ev.rec.messageId, t);
    if (cls === 'accept-on-speech' || cls === 'held-coalesced') {
      // A granted bid discharges on its turn's end; forget the open marker.
      openBidByAuthor.delete(author);
    }
    outcomes.push({ messageId: ev.rec.messageId, at: t, authorId: author, kind, cls, contended });
    prevSpeech = ev.rec;
  }
  flushRelease();

  // ── Report ──
  const classes: Record<SpeechClass, number> = {
    'held-coalesced': 0, 'accept-on-speech': 0, blocked: 0, unoffered: 0, 'post-expiry': 0, unbid: 0,
  };
  const byKind: Record<ParticipantKind, number> = { human: 0, agent: 0 };
  const interventionsByKind: Record<ParticipantKind, number> = { human: 0, agent: 0 };
  const perIdentity: FairnessDiffReport['perIdentity'] = {};
  const isViolation = (c: SpeechClass) => c === 'blocked' || c === 'unoffered' || c === 'post-expiry' || c === 'unbid';

  for (const o of outcomes) {
    classes[o.cls] += 1;
    byKind[o.kind] += 1;
    const row = perIdentity[o.authorId] ??= { kind: o.kind, messages: 0, grants: 0, violations: 0, offerExpiries: 0 };
    row.messages += 1;
    if (isViolation(o.cls)) { interventionsByKind[o.kind] += 1; row.violations += 1; }
    if (o.cls === 'accept-on-speech') row.grants += 1;
  }

  const expiries = book.eventLog().filter((e) => e.type === 'grant/offer-expired');
  for (const e of expiries) {
    const grantId = (e.data as { grantId?: string }).grantId;
    const offer = offersIssued.find((o) => o.grantId === grantId);
    if (offer) (perIdentity[offer.participantId] ??= { kind: kindOf(offer.participantId), messages: 0, grants: 0, violations: 0, offerExpiries: 0 }).offerExpiries += 1;
  }
  const lapses = book.eventLog().filter((e) => e.type === 'bid/lapsed').length;

  // Concordance: an offer is mismatched when its recipient was not the
  // room's next actual speaker after the offer was issued.
  let mismatchedOffers = 0;
  for (const offer of offersIssued) {
    const next = records.find((r) => r.at >= offer.at);
    if (next && next.authorId !== offer.participantId) mismatchedOffers += 1;
  }

  const msgCounts = new Map<string, number>();
  for (const r of records) msgCounts.set(r.authorId, (msgCounts.get(r.authorId) ?? 0) + 1);
  const grantCounts = new Map<string, number>();
  for (const [id, row] of Object.entries(perIdentity)) grantCounts.set(id, row.grants);
  const share = (m: Map<string, number>): number => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return total === 0 ? 0 : Math.max(...m.values()) / total;
  };
  const fairnessByKind: Record<ParticipantKind, { messages: number; grants: number }> = {
    human: { messages: 0, grants: 0 }, agent: { messages: 0, grants: 0 },
  };
  for (const row of Object.values(perIdentity)) {
    fairnessByKind[row.kind].messages += row.messages;
    fairnessByKind[row.kind].grants += row.grants;
  }

  let quietEpochs = 0;
  for (let k = 1; k < records.length; k++) {
    if (records[k].at - records[k - 1].at > knobs.idleAfterMs) quietEpochs += 1;
  }

  const violations = outcomes.filter((o) => isViolation(o.cls));
  const contendedOutcomes = outcomes.filter((o) => o.contended);
  const uncontended = outcomes.length - contendedOutcomes.length;
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

  return {
    knobs,
    messages: outcomes.length,
    byKind,
    classes,
    interventionRate: rate(violations.length, outcomes.length),
    interventionByKind: {
      human: rate(interventionsByKind.human, byKind.human),
      agent: rate(interventionsByKind.agent, byKind.agent),
    },
    contention: {
      contendedMessages: contendedOutcomes.length,
      interventionRateContended: rate(contendedOutcomes.filter((o) => isViolation(o.cls)).length, contendedOutcomes.length),
      interventionRateUncontended: rate(violations.length - contendedOutcomes.filter((o) => isViolation(o.cls)).length, uncontended),
    },
    concordance: {
      offersIssued: offersIssued.length,
      mismatchedOffers,
      offerExpiries: expiries.length,
      lapses,
    },
    fairness: {
      topAuthorMessageShare: share(msgCounts),
      topAuthorGrantShare: share(grantCounts),
      byKind: fairnessByKind,
    },
    clockFit: {
      quietEpochs,
      burstsCoalesced: classes['held-coalesced'],
      offerExpiries: expiries.length,
      leaseExpiries: book.eventLog().filter((e) => e.type === 'grant/lease-expired').length,
    },
    perIdentity,
    outcomes,
  };
}

/** The public aggregate — everything in the report EXCEPT per-identity
 *  rows and the raw outcome stream (design doc privacy posture: the room
 *  knows who talks most; the instrument shouldn't be the one saying it). */
export function publicAggregate(report: FairnessDiffReport): Omit<FairnessDiffReport, 'perIdentity' | 'outcomes'> {
  const { perIdentity: _p, outcomes: _o, ...aggregate } = report;
  return aggregate;
}
