/**
 * Shadow bids — stage 0b of the testing ladder in its credible live form
 * (FLOOR-RFC-001 rev 9, staged path): consenting agents' adapters place
 * GENUINE bids into a real book that grants nothing. The arbiter runs the
 * real logic against the live room and ledgers what it would have decided;
 * no participant's behavior changes, and nothing is ever sent.
 *
 * Why this exists (rev 9's own words): the fairness-diff replayer's
 * δ-sweep proved synthesized bids are calibration artifacts — the human
 * intervention rate swung 14× on one free parameter — so counterfactual
 * claims want gesture-derived bids or none. An agent's `!floor bid` op is
 * exactly that gesture: an intention observed BEFORE speech, recorded from
 * a consenting participant, no synthesis fiction anywhere in the book.
 *
 * What it shares with its neighbors:
 * - 0a's zero-send discipline, as EXECUTABLE evidence (Mica 2026-08-28,
 *   seam 4): the runner accepts the full transport, sends available, and
 *   only onMessage/close are ever touched — conformance instruments the
 *   send paths and asserts zero, on both surfaces.
 * - The replayer's counterfactual semantics, applied live: acceptance is
 *   accept-on-speech (offers cannot be delivered, so the bidder's actual
 *   room speech is the acceptance evidence); burst coalescing applies to
 *   agent leases only (C3); speech that the floor would have refused
 *   never mutates the room — the ledger records the disagreement and the
 *   spent bid is cancelled.
 * - The host's book discipline: real FloorService + FluidFairnessLogic,
 *   head advance on room speech (§2.2), clock-gap witnessing, idle epochs
 *   ledgered (never emitted).
 *
 * §9 posture: every record is metadata — op protocol values, book events,
 * rhythm rows (via the audited ShadowRecorder shape), and outcome
 * classifications. Outcome rows exist ONLY for consenting participants:
 * fairness numbers about people who didn't opt in are precisely what the
 * design doc's privacy section says the instrument must not produce. Ops
 * from non-consenting ids are ledgered as a refusal (verb only, args
 * dropped) and otherwise ignored.
 */

import { FloorService } from '../src/service.js';
import { FluidFairnessLogic } from '../src/logics.js';
import type { Grant } from '../src/types.js';
import { parseOp, parseDuration, type FloorOp } from './band.js';
import { ShadowRecorder } from './shadow.js';
import type { InboundMessage, RoomTransport } from './transport.js';

/** The replayer's speech taxonomy, computed live. */
export type ShadowSpeechClass =
  | 'held-coalesced'
  | 'accept-on-speech'
  | 'blocked'
  | 'unoffered'
  | 'post-expiry'
  | 'unbid';

export interface ShadowBidsOptions {
  /** Participants whose ops are accepted and whose speech is classified.
   *  Everyone else contributes rhythm rows only. Non-optional and
   *  non-empty by construction: an instrument with no consenting
   *  participants is 0a and should run as 0a. */
  consentingIds: string[];
  tickMs?: number;
  /** Agent-lease burst hold after each held speech (rev 9 §6). */
  burstReleaseMs?: number;
  /** Contention window for outcome rows (harvest-derived; default 5 s). */
  contentionWindowMs?: number;
  /** Quiet-epoch threshold, ledgered as `idle` (C1 rhythm-derived). */
  idleAfterMs?: number;
  clockGapThresholdMs?: number;
  logic?: FluidFairnessLogic;
  /** Room-registration timestamp. Defaults to Date.now() for live runs;
   *  conformance passes an explicit epoch so the core stays a pure
   *  function of observed time (the registration event is ledgered and
   *  feeds the idle clock like any other book event). */
  startedAt?: number;
}

export interface ShadowBidsRunner {
  runner: ShadowBidsCore;
  stop: () => Promise<void>;
}

/**
 * The injectable core — run-shadow-bids.ts calls this and nothing else
 * with the transport. Mirrors startShadow's deliberate shape: the full
 * RoomTransport is accepted, send methods available, and only
 * onMessage/close are ever touched (pinned by conformance).
 */
export function startShadowBids(
  transport: RoomTransport,
  ledger: (entry: Record<string, unknown>) => void,
  opts: ShadowBidsOptions,
): ShadowBidsRunner {
  const core = new ShadowBidsCore(transport.locator, transport.provenance, ledger, opts);
  transport.onMessage((m) => core.observe(m));
  core.start();
  return {
    runner: core,
    stop: async () => {
      core.stop();
      await transport.close();
    },
  };
}

export class ShadowBidsCore {
  readonly service: FloorService;
  readonly roomId: string;
  private readonly consenting: Set<string>;
  private readonly rhythm: ShadowRecorder;
  private readonly logic: FluidFairnessLogic;
  private joined = new Map<string, string>();
  private bidCounter = 0;
  private lastSeq = 0;
  private lastRoomMessageId: string | null = null;
  /** Live accepted grant riding a burst window: released when
   *  burstReleaseMs elapses after the holder's last speech. */
  private held: { grant: Grant; lastSpeechAt: number } | null = null;
  /** Room-surface rhythm state for the contention classification. */
  private prevRoom: { at: number; authorId: string } | null = null;

  // Idle machinery — the host's sequence-driven shape (FINDING-7 / S6),
  // ledger-only: a shadow instrument's idle epoch is data, not a wake.
  // Clocks seed lazily from the first observed timestamp, never from
  // Date.now(): the core must be a pure function of what it observes, so
  // conformance (and any future replay over a recorded feed) can drive
  // time by hand.
  private lastActivityAt: number | null = null;
  private lastActivityCause = 'startup';
  private lastIdleAt = 0;
  private idleArmed = true;
  private activitySeq = 0;
  private idleSeenSeq = 0;
  private lastClockSeen: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    locator: string,
    provenance: string,
    private ledger: (entry: Record<string, unknown>) => void,
    private opts: ShadowBidsOptions,
  ) {
    if (!opts.consentingIds.length) {
      throw new Error('shadow-bids needs at least one consenting participant — with none, run stage 0a (rhythm only)');
    }
    this.consenting = new Set(opts.consentingIds);
    this.logic = opts.logic ?? new FluidFairnessLogic();
    const t0 = opts.startedAt ?? Date.now();
    this.service = new FloorService(`shadow-bids-${t0.toString(36)}`);
    const room = this.service.registerRoom(locator, provenance, this.logic, t0);
    this.roomId = room.roomId;
    this.rhythm = new ShadowRecorder((entry) => this.ledger(entry));
  }

  start(): void {
    this.timer = setInterval(() => this.pump(Date.now()), this.opts.tickMs ?? 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get book() {
    return this.service.room(this.roomId).book;
  }

  // ── inbound ──

  observe(m: InboundMessage): void {
    this.reconcileClock(m.at);
    // Rhythm rows for everyone — this instrument strictly extends 0a's
    // data product; the audited record shape is reused verbatim.
    this.rhythm.observe(m);
    if (m.surface === 'room') {
      this.onSpeech(m);
      return;
    }
    const op = parseOp(m.text);
    if (!op) return; // ordinary chatter in the control surface
    if (!this.consenting.has(m.authorId)) {
      // Minimization: the refusal is ledgered (verb only — no args), the
      // op is otherwise ignored, and nothing answers it. A non-consenting
      // party gets no fairness row and no book entry.
      this.ledger({ kind: 'op-unconsented', at: m.at, participantId: m.authorId, op: op.verb });
      return;
    }
    this.ledger({ kind: 'op', at: m.at, participantId: m.authorId, op: op.verb, id: op.id, args: op.args, raw: m.raw });
    try {
      this.apply(op, m);
    } catch (err) {
      // Refusals reach the ledger even though no control band answers
      // (the host's lesson: an op whose refusal lives nowhere makes the
      // ledger claim it silently vanished).
      this.ledger({ kind: 'op-error', at: m.at, participantId: m.authorId, op: op.verb, id: op.id, reason: (err as Error).message });
    }
    this.noteActivity(m.at, 'op');
    this.pump(m.at);
  }

  /** The consenting-adapter op surface: bid-family only. Accept/decline/
   *  release/continue are refused by name — offers are never delivered in
   *  shadow, so grant-directed ops can only be confusion; the refusal
   *  reason says what to do instead (nothing — speech is the acceptance). */
  private apply(op: FloorOp, m: InboundMessage): void {
    const now = m.at;
    const pid = m.authorId;
    const c = this.book.currentContract!;
    switch (op.verb) {
      case 'join': {
        this.joined.set(pid, c.contractDigest);
        return;
      }
      case 'bid': {
        const acked = this.joined.get(pid);
        if (!acked) throw new Error('join first: bids bind a contract you have acknowledged (§3) — send !floor join');
        if (acked !== c.contractDigest) throw new Error('contract changed since you joined — re-join to acknowledge the new terms');
        // A zero-read adapter cannot know it currently holds the
        // counterfactual floor (nothing is ever delivered), so a bid
        // arriving from the live holder is the compose-start of a
        // continuation, not an error: the intent is already represented
        // by the live grant, and the continuation itself is measured as
        // held-coalesced speech. The op row above records the gesture.
        if (this.book.liveGrant?.participantId === pid) return;
        this.bidCounter += 1;
        const expires = op.args.expires ? parseDuration(op.args.expires) : null;
        this.book.createBid(
          {
            participantId: pid,
            bidId: `sb${this.bidCounter}`,
            createdAt: now,
            expiresAt: expires ? now + expires : null,
            readinessKind: (op.args.readiness as never) ?? 'intent',
            subjectRef: op.args.subject,
            payload: op.args.digest ? { digest: op.args.digest } : undefined,
          },
          now,
        );
        return;
      }
      case 'amend': {
        const patch: Record<string, unknown> = {};
        if (op.args.readiness) patch.readinessKind = op.args.readiness;
        if (op.args.subject) patch.subjectRef = op.args.subject;
        if (op.args.digest) patch.payload = { digest: op.args.digest };
        this.book.amendBid(op.id ?? this.mustOwnOpenBid(pid, op.verb), patch, now);
        return;
      }
      case 'cancel': {
        if (op.id) {
          this.book.cancelBid(op.id, now);
          return;
        }
        // Zero-read withdrawal races the arbiter: by the time the cancel
        // lands, the book may have OFFERED against the bid — and the
        // participant structurally cannot know (nothing is delivered).
        // The undelivered offer is withdrawn fairness-free (design doc,
        // withdrawn-bid semantics: cancel before a perceivable offer has
        // no fairness weight — book.declineGrant directly, not through
        // the service's terminal bookkeeping), then the bid is cancelled.
        const live = this.book.liveGrant;
        if (live && live.participantId === pid && live.state === 'offered') {
          this.book.declineGrant(live.grantId, now, 'withdrawn-in-shadow');
          this.book.cancelBid(live.bidId, now);
          return;
        }
        this.book.cancelBid(this.mustOwnOpenBid(pid, op.verb), now);
        return;
      }
      case 'ack':
        this.book.acknowledged(op.id ?? 'room-head', pid, now);
        return;
      default:
        throw new Error(
          `${op.verb} has no shadow analog: offers are never delivered, speech itself is the acceptance — bid/amend/cancel/ack only`,
        );
    }
  }

  /** Room speech: head advance, outcome classification for consenting
   *  participants, accept-on-speech + burst lifecycle. */
  private onSpeech(m: InboundMessage): void {
    const now = m.at;
    const prev = this.prevRoom;
    this.prevRoom = { at: now, authorId: m.authorId };
    this.lastRoomMessageId = m.messageId;
    this.book.noteHead(m.messageId, now);
    this.noteActivity(now, 'speech');

    if (this.consenting.has(m.authorId)) {
      const contended =
        prev !== null &&
        prev.authorId !== m.authorId &&
        now - prev.at <= (this.opts.contentionWindowMs ?? 5_000);
      this.classifySpeech(m, now, contended);
    }
    this.pump(now);
  }

  private classifySpeech(m: InboundMessage, now: number, contended: boolean): void {
    const pid = m.authorId;
    const outcome = (cls: ShadowSpeechClass, extra?: Record<string, unknown>): void => {
      this.ledger({
        kind: 'shadow-outcome',
        at: now,
        participantId: pid,
        messageId: m.messageId,
        cls,
        contended,
        ...extra,
      });
    };

    // Already holding through a burst window: this speech extends it.
    if (this.held && this.held.grant.participantId === pid) {
      this.held.lastSpeechAt = now;
      outcome('held-coalesced', { grantId: this.held.grant.grantId });
      return;
    }

    const live = this.book.liveGrant;
    if (live && live.participantId === pid && live.state === 'offered') {
      // The counterfactual concordant case: the floor would have offered,
      // and the participant spoke — speech IS the acceptance (§6 applied
      // to shadow; offers cannot be delivered, so no op ever accepts).
      // The book may refuse a just-expired offer (the tick and the speech
      // race on a live clock): that refusal is exactly the C2 mismatch
      // and is classified honestly rather than swallowed.
      try {
        this.service.accept(this.roomId, live.grantId, now);
      } catch (err) {
        if ((err as Error).message.startsWith('late accept refused')) {
          outcome('post-expiry', { grantId: live.grantId });
          this.cancelSpentBid(pid, now);
          return;
        }
        throw err;
      }
      this.held = { grant: live, lastSpeechAt: now };
      outcome('accept-on-speech', { grantId: live.grantId });
      return;
    }

    if (live && live.participantId !== pid) {
      // Someone else's offer/lease was live: the floor disagrees with
      // what the room did. Voluntary compliance — the speech happened;
      // the spent intention (if any) is cancelled, the book is otherwise
      // untouched.
      outcome('blocked', { holder: live.participantId, grantId: live.grantId });
      this.cancelSpentBid(pid, now);
      return;
    }

    const open = this.book
      .listBids()
      .find((b) => b.participantId === pid && (b.state === 'open' || b.state === 'suspended'));
    if (open) {
      // The bid's own ignored-offer streak discriminates the two gap
      // classes: an offer already expired against this bid (the C2
      // mismatch, real-bid edition) vs. never offered at all (backoff or
      // queue position — the arbitration-gap class). Either way the
      // intention was spent out-of-band by this speech.
      outcome(open.ignoredOffers > 0 ? 'post-expiry' : 'unoffered', { bidId: open.bidId });
      this.book.cancelBid(open.bidId, now);
      return;
    }
    outcome('unbid');
  }

  /** Voluntary-compliance analog of the replayer: a blocked speaker's own
   *  open bid was discharged by the out-of-band speech. */
  private cancelSpentBid(pid: string, now: number): void {
    const open = this.book
      .listBids()
      .find((b) => b.participantId === pid && (b.state === 'open' || b.state === 'suspended'));
    if (open) this.book.cancelBid(open.bidId, now);
  }

  // ── the loop ──

  pump(now: number): void {
    this.reconcileClock(now);
    // Burst-end release BEFORE arbitration: a held grant past its window
    // frees the floor this same pump, exactly as the adapter's atomic
    // release would have.
    if (this.held && now - this.held.lastSpeechAt >= (this.opts.burstReleaseMs ?? 2_500)) {
      const g = this.held.grant;
      this.held = null;
      // The grant may have lease-expired under a tick already; release
      // only a still-live grant.
      if (this.book.liveGrant?.grantId === g.grantId) {
        this.service.release(this.roomId, g.grantId, now);
      }
    }
    this.service.arbitrate(this.roomId, now);
    if (this.held && this.book.liveGrant?.grantId !== this.held.grant.grantId) {
      this.held = null; // lease expired under tick — burst state follows the book
    }
    this.flush();
    this.checkIdle(now);
  }

  /** Ledger the book's event stream — the counterfactual grant stream is
   *  the instrument's product. Nothing is emitted anywhere. */
  private flush(): void {
    for (const e of this.book.eventLog()) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      if (e.type !== 'grant/offered' && e.type !== 'grant/offer-expired' && e.type !== 'grant/lease-expired') {
        this.noteActivity(e.at, e.type);
      }
      this.ledger({
        kind: 'event',
        ...e,
        ...(e.type === 'grant/offered' ? { head: this.lastRoomMessageId ?? 'none' } : {}),
      });
    }
  }

  private reconcileClock(now: number): void {
    const cadence = this.opts.tickMs ?? 500;
    if (this.lastClockSeen !== null) {
      const gapMs = now - this.lastClockSeen;
      if (gapMs > (this.opts.clockGapThresholdMs ?? Math.max(10_000, cadence * 10))) {
        this.ledger({ kind: 'clock-gap', at: now, gapMs, expectedCadenceMs: cadence, processEpoch: this.book.processEpoch });
        this.book.tick(now);
      }
    }
    this.lastClockSeen = now;
  }

  private noteActivity(at: number, cause: string): void {
    this.lastActivityAt = at;
    this.lastActivityCause = cause;
    this.activitySeq += 1;
  }

  private checkIdle(now: number): void {
    const idleAfter = this.opts.idleAfterMs ?? 60_000;
    if (this.book.liveGrant) return;
    if (!this.idleArmed) {
      if (this.activitySeq > this.idleSeenSeq) {
        this.idleArmed = true;
        this.ledger({ kind: 'idle-rearm', at: now, cause: this.lastActivityCause });
      }
      return;
    }
    if (this.lastActivityAt === null) return; // nothing observed yet — quiet is not measurable
    if (now - Math.max(this.lastActivityAt, this.lastIdleAt) < idleAfter) return;
    this.lastIdleAt = now;
    this.idleSeenSeq = this.activitySeq;
    this.idleArmed = false;
    this.ledger({ kind: 'idle', at: now, quietMs: now - this.lastActivityAt });
  }

  /** Shadow inversion of the host's mustId: nothing is ever delivered, so
   *  a participant can never LEARN a bidId — id-less cancel/amend target
   *  the sender's own single active bid (the book enforces one per
   *  participant by replace semantics). An explicit id still works and is
   *  still validated by the book. */
  private mustOwnOpenBid(pid: string, verb: string): string {
    const own = this.book
      .listBids()
      .find((b) => b.participantId === pid && (b.state === 'open' || b.state === 'suspended'));
    if (!own) throw new Error(`${verb}: no open bid of yours to target — bids are per-participant and nothing was pending`);
    return own.bidId;
  }
}
