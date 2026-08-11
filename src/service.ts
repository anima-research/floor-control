/**
 * The floor service (FLOOR-RFC-001 §5–§7): room registry with binding
 * claims, logic wiring, and the chair API surface. Transport adapters
 * (WS/HTTP, MCPL, Portal, eidoverse) sit above this; none exist in the
 * skeleton — this is the core the conformance suite exercises.
 */

import { FloorBook } from './book.js';
import { FluidFairnessLogic, type Logic, type LogicDecision } from './logics.js';
import type { Bid, BindingClaim, Grant, Receipt } from './types.js';

export interface Room {
  roomId: string;
  book: FloorBook;
  logic: Logic;
  bindings: BindingClaim[];
}

export class FloorService {
  readonly processEpoch: string;
  private rooms = new Map<string, Room>();
  private roomCounter = 0;

  constructor(processEpoch: string) {
    this.processEpoch = processEpoch;
  }

  // ── Rooms & bindings (§5) ──

  /** Register a room with its first authenticated binding claim. The claim
   *  makes the binding addressable; it never auto-merges with any other
   *  binding — merging is `declareSharedBinding`, an explicit act. */
  registerRoom(locator: string, provenance: string, logic: Logic, now: number): Room {
    this.roomCounter += 1;
    const roomId = `room#${this.roomCounter}`;
    const book = new FloorBook(roomId, this.processEpoch);
    const room: Room = {
      roomId,
      book,
      logic,
      bindings: [{ locator, provenance, claimedAt: now, provisional: true }],
    };
    this.rooms.set(roomId, room);
    book.activateContract(logic.contract, now);
    return room;
  }

  /** A transport presenting the same authenticated provenance for an
   *  already-claimed locator deterministically lands on the same room. A
   *  DIFFERENT locator never merges implicitly, even with equal names. */
  claimBinding(roomId: string, locator: string, provenance: string, now: number): BindingClaim {
    const room = this.mustRoom(roomId);
    const existing = room.bindings.find((b) => b.locator === locator);
    if (existing) {
      if (existing.provenance !== provenance) {
        throw new Error(`binding ${locator} already claimed with different provenance`);
      }
      existing.provisional = false;
      return existing;
    }
    const claim: BindingClaim = { locator, provenance, claimedAt: now, provisional: true };
    room.bindings.push(claim);
    return claim;
  }

  /** Explicit multi-binding declaration (§9): sameness is declared, never
   *  inferred. One live grant then excludes holders across ALL bindings —
   *  which is automatic, because bindings share one book. */
  declareSharedBinding(roomId: string, locator: string, provenance: string, now: number): BindingClaim {
    return this.claimBinding(roomId, locator, provenance, now);
  }

  findRoomByBinding(locator: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.bindings.some((b) => b.locator === locator)) return room;
    }
    return undefined;
  }

  // ── The arbitration loop ──

  /** Ask the room's logic for a decision and apply it through the book's
   *  guarded ops. Returns the applied decision. This is the ONLY path from
   *  logic to grant — bids cannot self-grant. */
  arbitrate(roomId: string, now: number): { decision: LogicDecision; grant?: Grant } {
    const room = this.mustRoom(roomId);
    const preTick = room.book.liveGrant;
    room.book.tick(now);
    // A lease that expired under the tick consumed the floor too: charge the
    // holder's fairness history and strike count (FINDING-1 — without this,
    // the reopened bid stays "never held" and recaptures the floor forever).
    if (preTick && !room.book.liveGrant) {
      const receipt = room.book.receiptFor(preTick.grantId);
      if (receipt?.terminal === 'expired' && room.logic instanceof FluidFairnessLogic) {
        room.logic.noteExpired(preTick.participantId, now);
      }
    }
    const decision = room.logic.decide(room.book, now);
    if (decision.kind === 'grant') {
      const grant = room.book.offerGrant(decision.bidId, decision.bidRevision, now + decision.leaseMs, now);
      return { decision, grant };
    }
    return { decision };
  }

  /** Terminal bookkeeping shared by all release paths: forwards fairness
   *  history to logics that track it. */
  private noteTerminal(room: Room, grant: Grant, at: number): void {
    if (room.logic instanceof FluidFairnessLogic) {
      room.logic.noteTerminal(grant.participantId, at);
    }
  }

  release(roomId: string, grantId: string, now: number, boundary?: Receipt['boundary']): Receipt {
    const room = this.mustRoom(roomId);
    const grant = room.book.liveGrant;
    const receipt = room.book.releaseGrant(grantId, now, boundary);
    if (grant) this.noteTerminal(room, grant, now);
    return receipt;
  }

  decline(roomId: string, grantId: string, now: number, reason?: string): Receipt {
    const room = this.mustRoom(roomId);
    const grant = room.book.liveGrant;
    const receipt = room.book.declineGrant(grantId, now, reason);
    if (grant) this.noteTerminal(room, grant, now);
    return receipt;
  }

  // ── Chair API (§3: API-driven chairs; §4 chaired logic) ──

  /** Manual grant through the contract's announced API. Authorized against
   *  the active contract's chairId knob; the book's invariants (one live
   *  grant, exact revision, positive expiry) apply unchanged — a chair is
   *  powerful, not exempt. */
  chairGrant(roomId: string, actorId: string, bidId: string, bidRevision: number, leaseMs: number, now: number): Grant {
    const room = this.mustRoom(roomId);
    this.mustBeChair(room, actorId);
    return room.book.offerGrant(bidId, bidRevision, now + leaseMs, now);
  }

  chairRevoke(roomId: string, actorId: string, grantId: string, now: number, reason?: string): Receipt {
    const room = this.mustRoom(roomId);
    this.mustBeChair(room, actorId);
    const grant = room.book.liveGrant;
    const receipt = room.book.revokeGrant(grantId, now, reason ?? `revoked by chair ${actorId}`);
    if (grant) this.noteTerminal(room, grant, now);
    return receipt;
  }

  chairRestate(roomId: string, actorId: string, now: number, note?: string): void {
    const room = this.mustRoom(roomId);
    this.mustBeChair(room, actorId);
    room.book.restate(now, note);
  }

  // ── Restart (§2.3 epoch death) ──

  /** Rebuild the service in a new process epoch from persisted rooms.
   *  Grants are never restored; durable bids come back 'stale'. */
  static restore(
    newProcessEpoch: string,
    persisted: Array<{ roomId: string; bindings: BindingClaim[]; logic: Logic; durableBids: Bid[] }>,
    now: number,
  ): FloorService {
    const svc = new FloorService(newProcessEpoch);
    for (const p of persisted) {
      const book = FloorBook.restore(p.roomId, newProcessEpoch, p.durableBids, now);
      book.activateContract(p.logic.contract, now);
      svc.rooms.set(p.roomId, { roomId: p.roomId, book, logic: p.logic, bindings: p.bindings });
      const n = Number(p.roomId.split('#')[1]);
      if (Number.isFinite(n)) svc.roomCounter = Math.max(svc.roomCounter, n);
    }
    return svc;
  }

  room(roomId: string): Room {
    return this.mustRoom(roomId);
  }

  private mustRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    return room;
  }

  private mustBeChair(room: Room, actorId: string): void {
    const chairId = room.book.currentContract?.contract.knobs.chairId;
    if (chairId !== actorId) {
      throw new Error(`actor ${actorId} is not this room's chair (contract names ${String(chairId)})`);
    }
  }
}
