/**
 * FloorRoomHost — binds one room (a transport's two surfaces) to a
 * FloorService and runs the live arbitration loop the conformance suite can't:
 * real clock, real participants, real latencies.
 *
 * The host is the room's arbiter identity (§9): it connects as itself, posts
 * structured events to the control surface, and never speaks in the room
 * band. It also audits voluntary compliance — speech in the room by a joined
 * participant who does not hold the floor is logged as a violation event, not
 * blocked (§1: the service is a consumer of the room, not a gate).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FloorService } from '../src/service.js';
import { FluidFairnessLogic, type Logic } from '../src/logics.js';
import type { Grant } from '../src/types.js';
import { parseOp, parseDuration, eventLine, type FloorOp } from './band.js';
import type { InboundMessage, RoomTransport } from './transport.js';

export interface HostOptions {
  tickMs?: number;
  /** JSONL ledger path; unset = in-memory only. */
  ledgerPath?: string;
  /** participantIds exempt from compliance audit (humans, per Session 1). */
  exemptIds?: string[];
  /** Quiet-room liveness (FINDING-2, Mica's shape): after this much silence
   *  with a free floor and an empty book, the host emits a logged
   *  `floor/idle` event that wake policies and standing-ready clients can
   *  target — liveness never depends on an unlogged human nudge. */
  idleAfterMs?: number;
  /** Clock-gap witness threshold (host-sleep ruling). Default
   *  max(10s, 10×tickMs); the loopback suspend/resume scenario shrinks it. */
  clockGapThresholdMs?: number;
}

export class FloorRoomHost {
  readonly service: FloorService;
  readonly roomId: string;
  /** participantId → acknowledged contractDigest. */
  private joined = new Map<string, string>();
  private bidCounter = 0;
  private lastSeq = 0;
  private lastRoomMessageId: string | null = null;
  private lastActivityAt = Date.now();
  private lastActivityCause = 'startup';
  private lastIdleAt = 0;
  /** floor/idle fires ONCE per quiet epoch, then disarms; it re-arms only on
   *  an actual liveness transition (speech, book activity), with the cause
   *  recorded — a genuinely quiet room must not get a periodic wake source
   *  out of its liveness primitive (Mica, 2026-08-11). */
  private idleArmed = true;
  idleEmissions = 0;
  readonly idleRearms: Array<{ at: number; cause: string }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly violations: Array<{ at: number; participantId: string; messageId: string }> = [];

  constructor(
    private transport: RoomTransport,
    private logic: Logic,
    private opts: HostOptions = {},
  ) {
    this.service = new FloorService(`trial-${Date.now().toString(36)}`);
    const room = this.service.registerRoom(transport.locator, transport.provenance, logic, Date.now());
    this.roomId = room.roomId;
    if (opts.ledgerPath) mkdirSync(dirname(opts.ledgerPath), { recursive: true });
  }

  start(): void {
    this.transport.onMessage((m) => this.onMessage(m));
    this.timer = setInterval(() => this.pump(), this.opts.tickMs ?? 500);
    const c = this.book.currentContract!;
    void this.transport.sendControl(
      eventLine('room/registered', {
        roomId: this.roomId,
        logic: c.contract.logicId,
        epoch: c.logicEpoch,
        digest: c.contractDigest.slice(0, 12),
        hint: '!floor_join_to_participate',
      }),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get book() {
    return this.service.room(this.roomId).book;
  }

  // ── inbound ──

  private onMessage(m: InboundMessage): void {
    // Suspend/resume discipline (Mica, host-sleep ruling): detect and log
    // any clock gap, then reconcile every overdue offer/lease BEFORE
    // processing new grants or speech. The book's expiry receipts carry
    // deadline+overdueMs, so a late expiry is never represented as punctual.
    this.reconcileClock(m.at);
    if (m.surface === 'room') {
      this.lastRoomMessageId = m.messageId;
      this.lastActivityAt = m.at;
      this.lastActivityCause = 'speech';
      this.audit(m);
      this.pump();
      return;
    }
    const op = parseOp(m.text);
    if (!op) return; // ordinary chatter in the control thread
    this.ledger({ kind: 'op', at: m.at, participantId: m.authorId, op: op.verb, id: op.id, args: op.args, raw: m.raw });
    try {
      this.apply(op, m);
    } catch (err) {
      void this.transport.sendControl(
        eventLine('error', { op: op.verb, from: m.authorName, reason: (err as Error).message }),
      );
    }
    this.pump();
  }

  private apply(op: FloorOp, m: InboundMessage): void {
    const now = m.at;
    const pid = m.authorId;
    const c = this.book.currentContract!;
    switch (op.verb) {
      case 'join': {
        // FINDING-7 (accepted 2026-08-13): a GENUINE join is a logged
        // liveness transition and begins a new quiet epoch — a newcomer
        // must be able to receive a fresh floor/idle; an idle emitted
        // before they existed is not notice to them. Duplicate processing
        // of the same participant's join is idempotent: the notice is
        // re-sent, but it is not a second liveness transition (no repeated
        // wake). Re-arm stays event-driven; no periodic source exists.
        const firstJoin = !this.joined.has(pid);
        this.joined.set(pid, c.contractDigest);
        if (firstJoin) {
          this.lastActivityAt = now;
          this.lastActivityCause = 'participant/joined';
        }
        void this.transport.sendControl(
          eventLine('joined', {
            participant: m.authorName,
            logic: c.contract.logicId,
            epoch: c.logicEpoch,
            digest: c.contractDigest.slice(0, 12),
            speechLeaseMs: c.contract.knobs.speechLeaseMs,
          }),
        );
        return;
      }
      case 'bid': {
        this.mustBeJoined(pid, c.contractDigest);
        this.bidCounter += 1;
        const expires = op.args.expires ? parseDuration(op.args.expires) : null;
        const bid = this.book.createBid(
          {
            participantId: pid,
            bidId: `b${this.bidCounter}`,
            createdAt: now,
            expiresAt: expires ? now + expires : null,
            readinessKind: (op.args.readiness as never) ?? 'intent',
            subjectRef: op.args.subject,
            payload: op.args.digest ? { digest: op.args.digest } : undefined,
          },
          now,
        );
        void this.transport.sendControl(eventLine('bid/accepted', { bidId: bid.bidId, participant: m.authorName, r: bid.revision }));
        return;
      }
      case 'amend': {
        const patch: Record<string, unknown> = {};
        if (op.args.readiness) patch.readinessKind = op.args.readiness;
        if (op.args.subject) patch.subjectRef = op.args.subject;
        if (op.args.digest) patch.payload = { digest: op.args.digest };
        const bid = this.book.amendBid(this.mustId(op), patch, now);
        void this.transport.sendControl(eventLine('bid/amended', { bidId: bid.bidId, r: bid.revision }));
        return;
      }
      case 'cancel':
        this.book.cancelBid(this.mustId(op), now);
        return;
      case 'accept':
        // A late accept is refused EXPLICITLY (FINDING-8): the book
        // terminates the offer as offer-expired and throws; the refusal
        // goes back on the control band rather than leaving the sender
        // believing it holds a floor the book already reclaimed.
        try {
          this.book.acceptGrant(this.mustId(op), now);
        } catch (err) {
          const reason = (err as Error).message;
          if (reason.startsWith('late accept refused')) {
            this.ledger({ kind: 'late-accept-refused', at: now, participantId: pid, grantId: this.mustId(op) });
            void this.transport.sendControl(
              eventLine('accept/refused', { grantId: this.mustId(op), participant: m.authorName, reason: 'accept-ttl-elapsed' }),
            );
            return;
          }
          throw err;
        }
        return;
      case 'decline':
        this.service.decline(this.roomId, this.mustId(op), now, op.args.reason);
        return;
      case 'release':
        this.service.release(this.roomId, this.mustId(op), now);
        return;
      case 'continue': {
        const ext = op.args.extend ? parseDuration(op.args.extend) : null;
        if (!ext) throw new Error('continue needs +<duration>, e.g. !floor continue g4 +15s');
        this.book.continueGrant(this.mustId(op), now + ext, now);
        return;
      }
      case 'ack':
        this.book.acknowledged(op.id ?? 'room-head', pid, now);
        return;
      case 'status':
        this.book.restate(now, `status for ${m.authorName}`);
        return;
    }
  }

  /** Voluntary-compliance audit (§1): log, never block. */
  private audit(m: InboundMessage): void {
    if (!this.joined.has(m.authorId)) return; // not a floor participant
    if (this.opts.exemptIds?.includes(m.authorId)) return;
    const holder = this.book.liveGrant;
    if (holder && holder.participantId === m.authorId) return;
    this.violations.push({ at: m.at, participantId: m.authorId, messageId: m.messageId });
    this.ledger({ kind: 'violation', at: m.at, participantId: m.authorId, messageId: m.messageId, raw: m.raw });
    void this.transport.sendControl(
      eventLine('violation', { participant: m.authorName, messageId: m.messageId, holder: holder?.participantId ?? 'none' }),
    );
  }

  // ── the loop ──

  /** Arbitrate + flush: the host's heartbeat, also run after every inbound. */
  pump(): void {
    const now = Date.now();
    this.reconcileClock(now);
    const { grant } = this.service.arbitrate(this.roomId, now);
    this.flush(grant);
    this.checkIdle(now);
  }

  /** Clock-gap witness: a tick that arrives far later than the cadence
   *  promises means the process was suspended (or starved). The gap is
   *  ledgered with the process epoch preserved, and the book reconciles
   *  every overdue deadline in one deterministic pass before any new
   *  arbitration or speech is processed. */
  private lastClockSeen = Date.now();
  private reconcileClock(now: number): void {
    const cadence = this.opts.tickMs ?? 500;
    const gapMs = now - this.lastClockSeen;
    if (gapMs > (this.opts.clockGapThresholdMs ?? Math.max(10_000, cadence * 10))) {
      this.ledger({
        kind: 'clock-gap',
        at: now,
        gapMs,
        expectedCadenceMs: cadence,
        processEpoch: this.book.processEpoch,
      });
      // Close overdue state before anything new — and keep the fairness
      // accounting the service would have applied had the tick been on time.
      const preTick = this.book.liveGrant;
      this.book.tick(now);
      if (preTick && !this.book.liveGrant && this.logic instanceof FluidFairnessLogic) {
        const receipt = this.book.receiptFor(preTick.grantId);
        if (receipt?.terminal === 'offer-expired' || receipt?.terminal === 'lease-expired') {
          this.logic.noteExpired(preTick.participantId, now);
        }
      }
    }
    this.lastClockSeen = now;
  }

  private checkIdle(now: number): void {
    const idleAfter = this.opts.idleAfterMs ?? 60_000;
    // Open-but-ungrantable bids (expiry backoff) do NOT veto idleness: if a
    // grantable bid existed, this pump's arbitrate would have granted it and
    // liveGrant would be set. An idle floor with a stuck book is still idle.
    if (this.book.liveGrant) return;
    if (!this.idleArmed) {
      // Disarmed after emitting: only a liveness transition re-arms, and the
      // cause goes in the ledger.
      if (this.lastActivityAt > this.lastIdleAt) {
        this.idleArmed = true;
        this.idleRearms.push({ at: now, cause: this.lastActivityCause });
        this.ledger({ kind: 'idle-rearm', at: now, cause: this.lastActivityCause });
      }
      return;
    }
    if (now - Math.max(this.lastActivityAt, this.lastIdleAt) < idleAfter) return;
    this.lastIdleAt = now;
    this.idleArmed = false;
    this.idleEmissions += 1;
    this.ledger({ kind: 'idle', at: now, quietMs: now - this.lastActivityAt });
    void this.transport.sendControl(
      eventLine('floor/idle', { quietMs: now - this.lastActivityAt, holder: 'none' }),
    );
  }

  private flush(offered?: Grant): void {
    for (const e of this.book.eventLog()) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      // A grant that was offered and then merely expired is a FAILED cycle,
      // not progress — it must not keep resetting the idle clock while an
      // unresponsive bidder churns (otherwise the room can never signal
      // open-floor to standing-ready participants).
      if (e.type !== 'grant/offered' && e.type !== 'grant/offer-expired' && e.type !== 'grant/lease-expired') {
        this.lastActivityAt = e.at;
        this.lastActivityCause = e.type;
      }
      this.ledger({ kind: 'event', ...e });
      const mention =
        offered && e.type === 'grant/offered' && e.data.grantId === offered.grantId
          ? offered.participantId
          : undefined;
      void this.transport.sendControl(
        eventLine(e.type, {
          ...e.data,
          ...(e.type === 'grant/offered' ? { head: this.lastRoomMessageId ?? 'none' } : {}),
        }),
        mention,
      );
    }
  }

  // ── internals ──

  private mustBeJoined(pid: string, digest: string): void {
    const acked = this.joined.get(pid);
    if (!acked) throw new Error('join first: bids bind a contract you have acknowledged (§3) — send !floor join');
    if (acked !== digest) throw new Error('contract changed since you joined — re-join to acknowledge the new terms');
  }

  private mustId(op: FloorOp): string {
    if (!op.id) throw new Error(`${op.verb} needs an id`);
    return op.id;
  }

  private ledger(entry: Record<string, unknown>): void {
    if (this.opts.ledgerPath) appendFileSync(this.opts.ledgerPath, JSON.stringify(entry) + '\n');
  }
}
