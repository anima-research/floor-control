/**
 * Initial logics (FLOOR-RFC-001 §4) — arbitrary declared matchers over the
 * book; these two are the first implementations, not a closed set.
 *
 * A logic never touches book state directly: it reads the open book and
 * returns a decision; the service applies it through the book's guarded
 * operations. That separation is what makes "a bid never self-grants" and
 * "revoke-before-regrant" properties of the system rather than promises of
 * each logic author.
 */

import type { FloorBook } from './book.js';
import type { Bid, LogicContract } from './types.js';

export interface GrantDecision {
  kind: 'grant';
  bidId: string;
  bidRevision: number;
  /** Lease duration in ms from now; the service computes leaseUntil. */
  leaseMs: number;
}

export interface HoldDecision {
  kind: 'hold';
  reason: string;
}

export type LogicDecision = GrantDecision | HoldDecision;

export interface Logic {
  readonly contract: LogicContract;
  /** Called by the service when the book may need a new decision: on bid
   *  changes, grant terminals, and ticks. Pure over (book, now). */
  decide(book: FloorBook, now: number): LogicDecision;
}

/**
 * Fluid fairness — the chairless multi-party ordering for text/eidoverse
 * rooms (§4). One grant at a time from an arrival-informed queue with an
 * anti-starvation rule: among open bids, pick the participant who has held
 * the floor least recently (never-held beats held-longest-ago); ties break
 * by bid arrival order. `urgent` bids jump the queue the way addressing
 * evidence does in voice. Deterministic: no randomness, no clock reads.
 */
export class FluidFairnessLogic implements Logic {
  readonly contract: LogicContract;
  private lastHeld = new Map<string, number>();
  /** Consecutive lease expiries per participant; cleared by any responsive
   *  terminal (release/decline/revoke). Trial FINDING-1: an expired grant
   *  consumed the scarce resource too — it must charge fairness history, and
   *  a repeatedly-unresponsive bidder must not recapture the floor forever. */
  private strikes = new Map<string, number>();
  private lastExpiredAt = new Map<string, number>();
  private readonly leaseMs: number;
  private readonly expiryBackoffMs: number;
  private readonly expiryBackoffCapMs: number;

  constructor(opts?: {
    leaseMs?: number;
    expiryBackoffMs?: number;
    expiryBackoffCapMs?: number;
    knobs?: Record<string, unknown>;
  }) {
    this.leaseMs = opts?.leaseMs ?? 30_000;
    this.expiryBackoffMs = opts?.expiryBackoffMs ?? this.leaseMs * 2;
    this.expiryBackoffCapMs = opts?.expiryBackoffCapMs ?? this.leaseMs * 8;
    this.contract = {
      logicId: 'fluid-fairness',
      version: 2,
      bidFields: {
        readinessKind: 'intent | prepared | urgent',
        subjectRef: 'optional — what the turn answers',
      },
      queueVisibility: 'full',
      eventShapes: ['floor:grant', 'floor:hold', 'floor:state', 'floor:idle'],
      api: [],
      knobs: {
        leaseMs: this.leaseMs,
        expiryBackoffMs: this.expiryBackoffMs,
        expiryBackoffCapMs: this.expiryBackoffCapMs,
        ...(opts?.knobs ?? {}),
      },
      moderation: [],
    };
  }

  noteTerminal(participantId: string, at: number): void {
    this.lastHeld.set(participantId, at);
    this.strikes.delete(participantId); // a responsive terminal clears strikes
  }

  /** An expired lease charges held-history AND accrues a strike: backoff
   *  doubles per consecutive expiry, bounded by expiryBackoffCapMs. */
  noteExpired(participantId: string, at: number): void {
    this.lastHeld.set(participantId, at);
    this.strikes.set(participantId, (this.strikes.get(participantId) ?? 0) + 1);
    this.lastExpiredAt.set(participantId, at);
  }

  private eligible(participantId: string, now: number): boolean {
    const s = this.strikes.get(participantId);
    if (!s) return true;
    const backoff = Math.min(this.expiryBackoffCapMs, this.expiryBackoffMs * 2 ** (s - 1));
    return now >= (this.lastExpiredAt.get(participantId) ?? 0) + backoff;
  }

  decide(book: FloorBook, now: number): LogicDecision {
    if (book.liveGrant) return { kind: 'hold', reason: 'floor occupied' };
    const open = book.openBids();
    if (open.length === 0) return { kind: 'hold', reason: 'no open bids' };
    // Expiry backoff DOWNRANKS (antra 2026-08-11: "downrank them for the
    // next few rounds"): in any contested round a struck bidder loses to
    // every eligible competitor. When even the round's best bid is in
    // backoff (a solo unresponsive bidder), the round HOLDS for the bounded
    // cooldown instead of granting — immediate regrant would churn
    // grant/expire cycles at a non-responder and keep the floor nominally
    // occupied, suppressing the open-floor idle signal standing-ready
    // participants depend on.
    const pick = (candidates: Bid[]): Bid =>
      candidates.slice().sort((a, b) => {
        const ea = this.eligible(a.participantId, now) ? 0 : 1;
        const eb = this.eligible(b.participantId, now) ? 0 : 1;
        if (ea !== eb) return ea - eb; // eligible before backed-off
        const ha = this.lastHeld.get(a.participantId) ?? -1;
        const hb = this.lastHeld.get(b.participantId) ?? -1;
        if (ha !== hb) return ha - hb; // least-recently-held first; never-held (-1) wins
        return a.createdAt - b.createdAt; // then arrival order
      })[0];
    const urgent = open.filter((b) => b.readinessKind === 'urgent');
    const chosen = urgent.length > 0 ? pick(urgent) : pick(open);
    if (!this.eligible(chosen.participantId, now)) {
      return { kind: 'hold', reason: 'best bid cooling down after lease expiry' };
    }
    return { kind: 'grant', bidId: chosen.bidId, bidRevision: chosen.revision, leaseMs: this.leaseMs };
  }
}

/**
 * Chaired (Session 1) — the book informs, the chair decides (§4, §8). The
 * logic itself always holds; grants happen only through the chair API the
 * contract announces (service.chairGrant). ✋ is a `manual` bid; restate,
 * withdraw, and the one-sentence substitute ride the book's own verbs.
 */
export class ChairedLogic implements Logic {
  readonly contract: LogicContract;

  constructor(chairId: string, knobs?: Record<string, unknown>) {
    this.contract = {
      logicId: 'chaired-session1',
      version: 1,
      bidFields: { readinessKind: 'manual (✋)', subjectRef: 'optional — agenda item' },
      queueVisibility: 'full',
      eventShapes: ['floor:grant', 'floor:state'],
      api: ['chair/grant', 'chair/revoke', 'chair/restate'],
      knobs: {
        chairId,
        debounceMs: 15_000,
        turnCap: 'two paragraphs, dense if needed',
        exemptions: ['humans speak freely without hands'],
        ...(knobs ?? {}),
      },
      moderation: [],
    };
  }

  decide(): LogicDecision {
    return { kind: 'hold', reason: 'chair discretion: the queue informs, the chair decides' };
  }
}
