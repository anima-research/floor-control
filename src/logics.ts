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
  private readonly leaseMs: number;

  constructor(opts?: { leaseMs?: number; knobs?: Record<string, unknown> }) {
    this.leaseMs = opts?.leaseMs ?? 30_000;
    this.contract = {
      logicId: 'fluid-fairness',
      version: 1,
      bidFields: {
        readinessKind: 'intent | prepared | urgent',
        subjectRef: 'optional — what the turn answers',
      },
      queueVisibility: 'full',
      eventShapes: ['floor:grant', 'floor:hold', 'floor:state'],
      api: [],
      knobs: { leaseMs: this.leaseMs, ...(opts?.knobs ?? {}) },
      moderation: [],
    };
  }

  noteTerminal(participantId: string, at: number): void {
    this.lastHeld.set(participantId, at);
  }

  decide(book: FloorBook, now: number): LogicDecision {
    if (book.liveGrant) return { kind: 'hold', reason: 'floor occupied' };
    const open = book.openBids();
    if (open.length === 0) return { kind: 'hold', reason: 'no open bids' };
    const pick = (candidates: Bid[]): Bid =>
      candidates.slice().sort((a, b) => {
        const ha = this.lastHeld.get(a.participantId) ?? -1;
        const hb = this.lastHeld.get(b.participantId) ?? -1;
        if (ha !== hb) return ha - hb; // least-recently-held first; never-held (-1) wins
        return a.createdAt - b.createdAt; // then arrival order
      })[0];
    const urgent = open.filter((b) => b.readinessKind === 'urgent');
    const chosen = urgent.length > 0 ? pick(urgent) : pick(open);
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
