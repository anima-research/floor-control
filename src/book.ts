/**
 * The per-room order book — FLOOR-RFC-001 §2's state machine.
 *
 * Deterministic by construction: no clock reads, no randomness — every
 * operation takes explicit `now`, ids are caller-supplied or derived from a
 * counter, and every state change appends to the room's event log. Same
 * inputs ⇒ same log; the determinism conformance test replays one.
 *
 * The book holds no arbitration opinion. Only a logic (via LogicHandle in
 * service.ts) or a chaired contract's API may call `offerGrant`; the book
 * enforces the invariants that make any logic safe to run:
 *
 *   - a bid never self-grants (there is no path from bid/create to a grant
 *     that doesn't pass through the logic);
 *   - positive finite expiry on every grant;
 *   - revoke-before-regrant: one live grant per room, including handoffs;
 *   - grants bind the exact bid revision they answer — a stale revision is
 *     refused at offer time;
 *   - epoch death: grants never survive process restart or logic swap;
 *     durable bids survive as 'stale' and must be re-affirmed;
 *   - idempotent terminal receipts, deduped by grantId;
 *   - the acknowledged() trace never mutates book or grant state.
 */

import type {
  Bid,
  BidEnvelope,
  FloorEvent,
  Grant,
  LogicContract,
  Receipt,
  TerminalState,
} from './types.js';
import { digestContract } from './contract.js';

export class FloorBook {
  readonly roomId: string;
  readonly processEpoch: string;
  private logicEpoch = 0;
  private contract: LogicContract | null = null;
  private contractDigest = '';
  private bids = new Map<string, Bid>();
  private activeGrant: Grant | null = null;
  private receipts = new Map<string, Receipt>();
  private events: FloorEvent[] = [];
  private seq = 0;
  private grantCounter = 0;
  /** FINDING-9 (Mica, K=3): consecutive ignored offers before a bid lapses. */
  static readonly LAPSE_AFTER_IGNORED_OFFERS = 3;
  /** FINDING-10 (Mica, N=3): room-wide no-accept streak before degradation telemetry. */
  static readonly DEGRADED_AFTER_NO_ACCEPT_STREAK = 3;
  private consecutiveOfferExpiries = 0;
  private degradedEmitted = false;

  constructor(roomId: string, processEpoch: string) {
    this.roomId = roomId;
    this.processEpoch = processEpoch;
  }

  // ── Contract lifecycle (§3, §2.2 contract/changed) ──

  /** Activate a logic contract. Creates a new logicEpoch, revokes any live
   *  grant, and stales every open bid (they must be re-affirmed against the
   *  new contract — "invalidate/renegotiate", never silently carried). */
  activateContract(contract: LogicContract, now: number): void {
    this.logicEpoch += 1;
    this.contract = contract;
    this.contractDigest = digestContract(contract);
    if (this.activeGrant && this.activeGrant.state !== 'terminal') {
      this.terminate(this.activeGrant.grantId, 'revoked', now, 'contract change');
    }
    for (const bid of this.bids.values()) {
      if (bid.state === 'open' || bid.state === 'granted') {
        bid.state = 'stale';
        this.emit('bid/staled', now, { bidId: bid.bidId, reason: 'contract change' });
      }
    }
    this.emit('contract/changed', now, {
      logicEpoch: this.logicEpoch,
      contractDigest: this.contractDigest,
      logicId: contract.logicId,
      version: contract.version,
    });
  }

  get currentContract(): { contract: LogicContract; logicEpoch: number; contractDigest: string } | null {
    return this.contract
      ? { contract: this.contract, logicEpoch: this.logicEpoch, contractDigest: this.contractDigest }
      : null;
  }

  // ── Bids (§2.2) ──

  /** One open bid per participant: a speaking floor is not an order book —
   *  one identity cannot consume two concurrent turns. Creating a bid while
   *  one is already open/stale REPLACES it under the existing stable bidId
   *  (revision bump, `bid/replaced` in the ledger). Distinct concurrent
   *  proposals per participant would be an explicit future feature, never an
   *  accident. (Trial FINDING-3; ruling by Mica 2026-08-11.)
   *
   *  Fairness timestamp: replacement PRESERVES the original createdAt —
   *  editing a pending turn does not send you to the back of the queue.
   *  Revision churn cannot parlay that age into stale authority because a
   *  grant binds the exact revision it answers (offerGrant refuses any
   *  other) and a granted bid cannot be replaced or amended at all. */
  createBid(
    env: Omit<BidEnvelope, 'roomId' | 'logicEpoch' | 'contractDigest' | 'revision'>,
    now: number,
  ): Bid {
    if (!this.contract) throw new Error('no active contract: bids bind a contract they acknowledge');
    if (this.bids.has(env.bidId)) throw new Error(`bid ${env.bidId} already exists`);
    for (const existing of this.bids.values()) {
      if (existing.participantId !== env.participantId) continue;
      if (existing.state === 'granted') {
        throw new Error(`${env.participantId} holds a granted bid (${existing.bidId}); release or decline before rebidding`);
      }
      if (existing.state === 'open' || existing.state === 'stale') {
        if (existing.state === 'stale') {
          existing.state = 'open';
          existing.logicEpoch = this.logicEpoch;
          existing.contractDigest = this.contractDigest;
        }
        existing.readinessKind = env.readinessKind;
        existing.subjectRef = env.subjectRef;
        existing.expiresAt = env.expiresAt;
        existing.payload = env.payload;
        existing.revision += 1;
        existing.ignoredOffers = 0; // a replace is a responsive act
        this.emit('bid/replaced', now, {
          bidId: existing.bidId,
          participantId: existing.participantId,
          revision: existing.revision,
          readinessKind: existing.readinessKind,
        });
        return existing;
      }
    }
    const bid: Bid = {
      ...env,
      roomId: this.roomId,
      logicEpoch: this.logicEpoch,
      contractDigest: this.contractDigest,
      revision: 1,
      state: 'open',
      createdAt: now,
      ignoredOffers: 0,
    };
    this.bids.set(bid.bidId, bid);
    this.emit('bid/created', now, { bidId: bid.bidId, participantId: bid.participantId, readinessKind: bid.readinessKind });
    return bid;
  }

  amendBid(bidId: string, patch: Partial<Pick<Bid, 'subjectRef' | 'readinessKind' | 'expiresAt' | 'payload'>>, now: number): Bid {
    const bid = this.mustBid(bidId);
    if (bid.state === 'stale') {
      // Re-affirmation: amending a stale bid under the current contract
      // revives it — the participant has seen the new terms.
      bid.state = 'open';
      bid.logicEpoch = this.logicEpoch;
      bid.contractDigest = this.contractDigest;
    } else if (bid.state !== 'open') {
      throw new Error(`bid ${bidId} is ${bid.state}; only open/stale bids amend`);
    }
    Object.assign(bid, patch);
    bid.revision += 1;
    this.emit('bid/amended', now, { bidId, revision: bid.revision });
    return bid;
  }

  cancelBid(bidId: string, now: number): void {
    const bid = this.mustBid(bidId);
    if (bid.state === 'granted') throw new Error('cancel the grant, not the bid, once granted');
    bid.state = 'cancelled';
    this.emit('bid/cancelled', now, { bidId });
  }

  /** §8: a bid resolves into a recorded contribution without a grant. */
  substituteBid(bidId: string, recordedAs: string, now: number): void {
    const bid = this.mustBid(bidId);
    if (bid.state !== 'open' && bid.state !== 'stale') {
      throw new Error(`bid ${bidId} is ${bid.state}; only open/stale bids substitute`);
    }
    bid.state = 'substituted';
    this.emit('bid/substituted', now, { bidId, recordedAs });
  }

  listBids(): Bid[] {
    return [...this.bids.values()];
  }

  openBids(): Bid[] {
    return this.listBids().filter((b) => b.state === 'open');
  }

  // ── Grants (§2.2, §2.3) — logic-only entry via LogicHandle ──

  /** Offer a grant for the exact revision of an open bid. Refuses when a
   *  live grant exists (revoke-before-regrant), when the revision is stale,
   *  when the bid's contract binding is not current, or when the timing is
   *  not positive and finite. Two clocks (FINDING-8): `acceptBy` bounds the
   *  offer; the speech lease is applied at acceptance, not here. */
  offerGrant(
    bidId: string,
    bidRevision: number,
    timing: { acceptBy: number; speechLeaseMs: number },
    now: number,
  ): Grant {
    const bid = this.mustBid(bidId);
    if (bid.state !== 'open') throw new Error(`bid ${bidId} is ${bid.state}, not open`);
    if (bid.revision !== bidRevision) {
      throw new Error(`stale bid revision: grant answers r${bidRevision}, bid is at r${bid.revision}`);
    }
    if (bid.logicEpoch !== this.logicEpoch || bid.contractDigest !== this.contractDigest) {
      throw new Error('bid is bound to a previous contract; it must be re-affirmed first');
    }
    if (this.activeGrant && this.activeGrant.state !== 'terminal') {
      throw new Error('revoke-before-regrant: a live grant exists in this room');
    }
    if (!Number.isFinite(timing.acceptBy) || timing.acceptBy <= now) {
      throw new Error('positive expiry: acceptBy must be finite and after now');
    }
    if (!Number.isFinite(timing.speechLeaseMs) || timing.speechLeaseMs <= 0) {
      throw new Error('positive expiry: speechLeaseMs must be finite and positive');
    }
    this.grantCounter += 1;
    const grant: Grant = {
      grantId: `${this.roomId}#g${this.grantCounter}`,
      roomId: this.roomId,
      logicEpoch: this.logicEpoch,
      contractDigest: this.contractDigest,
      participantId: bid.participantId,
      bidId: bid.bidId,
      bidRevision,
      processEpoch: this.processEpoch,
      grantedAt: now,
      acceptBy: timing.acceptBy,
      speechLeaseMs: timing.speechLeaseMs,
      leaseUntil: timing.acceptBy,
      state: 'offered',
    };
    bid.state = 'granted';
    this.activeGrant = grant;
    this.emit('grant/offered', now, {
      grantId: grant.grantId,
      bidId,
      participantId: bid.participantId,
      acceptBy: timing.acceptBy,
      speechLeaseMs: timing.speechLeaseMs,
      leaseUntil: timing.acceptBy,
    });
    return grant;
  }

  /** Acceptance starts the speech lease (FINDING-8): a timely accept gets
   *  the FULL lease regardless of pre-accept relay delay. A late accept is
   *  refused explicitly — the offer is terminated offer-expired and the
   *  caller gets an error to surface, never a silent zombie hold. */
  acceptGrant(grantId: string, now: number): Grant {
    const g = this.mustLiveGrant(grantId);
    if (g.state !== 'offered') throw new Error(`grant ${grantId} is ${g.state}`);
    if (now > g.acceptBy) {
      this.expireOffer(g, now);
      throw new Error(`late accept refused: accept-TTL elapsed ${now - g.acceptBy}ms ago (grant ${grantId})`);
    }
    g.state = 'accepted';
    g.leaseUntil = now + g.speechLeaseMs;
    const bid = this.bids.get(g.bidId);
    if (bid) bid.ignoredOffers = 0; // acceptance clears the ignored-offer streak
    this.noteAcceptance(now);
    this.emit('grant/accepted', now, { grantId, leaseUntil: g.leaseUntil });
    return g;
  }

  declineGrant(grantId: string, now: number, reason?: string): Receipt {
    // The prepared-bid fast path's stale-head branch: winner declines, rebids.
    return this.terminate(grantId, 'declined', now, reason);
  }

  continueGrant(grantId: string, newLeaseUntil: number, now: number): Grant {
    const g = this.mustLiveGrant(grantId);
    if (!Number.isFinite(newLeaseUntil) || newLeaseUntil <= now) {
      throw new Error('positive expiry: continuation must extend to a finite future time');
    }
    g.leaseUntil = newLeaseUntil;
    this.emit('grant/continued', now, { grantId, leaseUntil: newLeaseUntil });
    return g;
  }

  releaseGrant(grantId: string, now: number, boundary?: Receipt['boundary']): Receipt {
    return this.terminate(grantId, 'released', now, undefined, boundary);
  }

  revokeGrant(grantId: string, now: number, reason?: string): Receipt {
    return this.terminate(grantId, 'revoked', now, reason);
  }

  /** Deterministic time passage: expire overdue offers, leases, and bids.
   *  The two grant clocks terminate differently (FINDING-8): an offered
   *  grant past acceptBy is offer-expired (and feeds lapse + degradation
   *  accounting); an accepted grant past its lease is lease-expired. */
  tick(now: number): void {
    const g = this.activeGrant;
    if (g && g.state === 'offered' && g.acceptBy <= now) {
      this.expireOffer(g, now);
    } else if (g && g.state === 'accepted' && g.leaseUntil <= now) {
      this.terminate(g.grantId, 'lease-expired', now);
    }
    for (const bid of this.bids.values()) {
      if (bid.state === 'open' && bid.expiresAt !== null && bid.expiresAt <= now) {
        bid.state = 'expired';
        this.emit('bid/cancelled', now, { bidId: bid.bidId, reason: 'expired' });
      }
    }
  }

  /** Offer-expiry bookkeeping shared by tick and late-accept refusal:
   *  terminal receipt, per-bid ignored-offer streak (lapse at 3 —
   *  FINDING-9, K=3), and the room-wide no-accept streak (degradation
   *  telemetry at 3 — FINDING-10, N=3; emitted once per episode, recovery
   *  receipt on next acceptance; never alters fairness or blocks bids). */
  private expireOffer(g: Grant, now: number): void {
    this.terminate(g.grantId, 'offer-expired', now);
    const bid = this.bids.get(g.bidId);
    if (bid) {
      bid.ignoredOffers += 1;
      if (bid.ignoredOffers >= FloorBook.LAPSE_AFTER_IGNORED_OFFERS && bid.state === 'open') {
        bid.state = 'lapsed';
        this.emit('bid/lapsed', now, {
          bidId: bid.bidId,
          participantId: bid.participantId,
          revision: bid.revision,
          cause: 'ignored-offers',
          expiryCount: bid.ignoredOffers,
        });
      }
    }
    this.consecutiveOfferExpiries += 1;
    if (this.consecutiveOfferExpiries >= FloorBook.DEGRADED_AFTER_NO_ACCEPT_STREAK && !this.degradedEmitted) {
      this.degradedEmitted = true;
      this.emit('book/degraded', now, {
        noAcceptStreak: this.consecutiveOfferExpiries,
        note: 'telemetry only: fairness, bids, and floor/idle are unaffected',
      });
    }
  }

  /** Acceptance resets the room-wide no-accept streak and closes any open
   *  degradation episode with a recovery receipt. */
  private noteAcceptance(now: number): void {
    this.consecutiveOfferExpiries = 0;
    if (this.degradedEmitted) {
      this.degradedEmitted = false;
      this.emit('book/recovered', now, {});
    }
  }

  /** Idempotent receipt fetch — the same terminal record every time. */
  receiptFor(grantId: string): Receipt | undefined {
    return this.receipts.get(grantId);
  }

  get liveGrant(): Grant | null {
    return this.activeGrant && this.activeGrant.state !== 'terminal' ? this.activeGrant : null;
  }

  // ── Neutral traces & visibility (§8, §2.2) ──

  /** The ✅-class trace: recorded, replayable, and — by construction —
   *  incapable of touching bids or grants. It only appends an event. */
  acknowledged(subjectRef: string, actor: string, now: number): void {
    this.emit('acknowledged', now, { subjectRef, actor });
  }

  restate(now: number, note?: string): void {
    this.emit('book/restated', now, {
      openBids: this.openBids().map((b) => b.bidId),
      holder: this.liveGrant?.participantId ?? null,
      ...(note ? { note } : {}),
    });
  }

  eventLog(): readonly FloorEvent[] {
    return this.events;
  }

  /** Restart semantics (§2.3): rebuild a book in a NEW process epoch from a
   *  prior book's durable bids. Grants are never restored; surviving open
   *  bids arrive 'stale' and must be re-affirmed. */
  static restore(roomId: string, newProcessEpoch: string, durableBids: Bid[], now: number): FloorBook {
    const book = new FloorBook(roomId, newProcessEpoch);
    for (const bid of durableBids) {
      if (bid.state === 'open' || bid.state === 'granted') {
        const revived: Bid = { ...bid, state: 'stale' };
        book.bids.set(revived.bidId, revived);
        book.emit('bid/staled', now, { bidId: bid.bidId, reason: 'process restart — revalidation required' });
      }
    }
    return book;
  }

  // ── internals ──

  private terminate(
    grantId: string,
    terminal: TerminalState,
    now: number,
    reason?: string,
    boundary?: Receipt['boundary'],
  ): Receipt {
    const existing = this.receipts.get(grantId);
    if (existing) return existing; // idempotent: exactly one terminal state
    const g = this.activeGrant;
    if (!g || g.grantId !== grantId) throw new Error(`no live grant ${grantId}`);
    // Truthful lateness (Mica, host-sleep ruling): an expiry detected late is
    // never represented as punctual — the receipt carries the scheduled
    // deadline and how overdue detection was.
    const deadline = g.state === 'offered' ? g.acceptBy : g.leaseUntil;
    const overdueMs = Math.max(0, now - deadline);
    g.state = 'terminal';
    const receipt: Receipt = {
      grantId,
      roomId: this.roomId,
      terminal,
      at: now,
      ...(boundary ? { boundary } : {}),
      ...(reason ? { reason } : {}),
    };
    this.receipts.set(grantId, receipt);
    const bid = this.bids.get(g.bidId);
    if (bid && bid.state === 'granted') {
      // Declined/revoked/expired turns return the bid to the book so the
      // participant may be matched again; released/completed consume it.
      // (Lapse, when due, is applied by expireOffer after this returns.)
      bid.state = terminal === 'released' || terminal === 'completed' ? 'cancelled' : 'open';
    }
    this.activeGrant = g; // kept for receipt lineage; liveGrant getter filters terminal
    const isExpiry = terminal === 'offer-expired' || terminal === 'lease-expired';
    this.emit(`grant/${terminal === 'completed' ? 'released' : terminal}` as FloorEvent['type'], now, {
      grantId,
      terminal,
      ...(isExpiry ? { deadline, overdueMs } : {}),
      ...(reason ? { reason } : {}),
    });
    return receipt;
  }

  private mustBid(bidId: string): Bid {
    const bid = this.bids.get(bidId);
    if (!bid) throw new Error(`unknown bid ${bidId}`);
    return bid;
  }

  private mustLiveGrant(grantId: string): Grant {
    const g = this.activeGrant;
    if (!g || g.grantId !== grantId || g.state === 'terminal') {
      throw new Error(`no live grant ${grantId}`);
    }
    return g;
  }

  private emit(type: FloorEvent['type'], at: number, data: Record<string, unknown>): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, at, type, data });
  }
}
