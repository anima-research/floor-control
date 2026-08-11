/**
 * FLOOR-RFC-001 §2 — the frozen base protocol's wire shapes.
 *
 * A logic defines its bid *payload*; the envelope is stable. Times are
 * explicit epoch-millis supplied by the caller — the library never reads a
 * clock, which is what makes replay and the determinism conformance test
 * possible.
 */

/** §2.1 — the stable bid envelope. Payload beyond this is contract-defined. */
export interface BidEnvelope {
  roomId: string;
  logicEpoch: number;
  contractDigest: string;
  participantId: string;
  bidId: string;
  revision: number;
  createdAt: number;
  expiresAt: number | null;
  /** What this bid answers / replies to (utterance, agenda item, message). */
  subjectRef?: string;
  readinessKind: ReadinessKind;
  /** Contract-defined payload. Prepared speech stays with its author: this
   *  carries digest/size/readiness token, not plaintext, unless the active
   *  contract explicitly requires semantic bid content (§2.1). */
  payload?: Record<string, unknown>;
}

export type ReadinessKind = 'intent' | 'prepared' | 'manual' | 'urgent';

export type BidState =
  | 'open'
  | 'granted'
  | 'cancelled'
  | 'expired'
  /** Logic swap or restart: the bid survives but must be re-affirmed
   *  against the new contract before it can be matched again (§2.3:
   *  durable bids MAY survive; zombie speaking authority may not). */
  | 'stale'
  /** Resolved into a recorded contribution without a grant (the Session 1
   *  one-sentence substitute, generalized — §8). */
  | 'substituted';

export interface Bid extends BidEnvelope {
  state: BidState;
}

/** §2.3 — a grant binds the exact bid revision it answers. */
export interface Grant {
  grantId: string;
  roomId: string;
  logicEpoch: number;
  contractDigest: string;
  participantId: string;
  bidId: string;
  bidRevision: number;
  processEpoch: string;
  grantedAt: number;
  /** Positive, finite expiry — always (§2.3). */
  leaseUntil: number;
  state: 'offered' | 'accepted' | 'terminal';
}

export type TerminalState =
  | 'completed'
  | 'released'
  | 'revoked'
  | 'expired'
  | 'declined';

/** §2.3 — idempotent terminal receipt, deduped by grantId, safe to re-send. */
export interface Receipt {
  grantId: string;
  roomId: string;
  terminal: TerminalState;
  at: number;
  /** Medium-reported boundary when a turn was cut (voice: voiced/unvoiced). */
  boundary?: { voiced?: string; unvoiced?: string; estimated?: boolean };
  reason?: string;
}

/** §3 — the announced logic contract: a real policy boundary. Versioned,
 *  digested, acknowledged before bids/grants bind it. */
export interface LogicContract {
  logicId: string;
  version: number;
  /** What a bid must contain, human+machine readable. */
  bidFields: Record<string, string>;
  /** Queue visibility & bid-content privacy declaration. */
  queueVisibility: 'full' | 'digests-only';
  /** Event shapes this logic emits (incl. optional wake shapes, `floor:*`). */
  eventShapes: string[];
  /** API the contract exposes (chair surfaces etc.); empty = none. */
  api: string[];
  /** Knobs and their current values (debounce, caps, exemptions…). */
  knobs: Record<string, unknown>;
  /** Moderation authority this room grants the service. Default: none. */
  moderation: string[];
}

/** §5 — a transport binding claim. Addressable ≠ auto-merged. */
export interface BindingClaim {
  /** Transport locator, e.g. "discord://<guild>/<channel>". */
  locator: string;
  /** Authenticated provenance presented by the claiming transport. */
  provenance: string;
  claimedAt: number;
  provisional: boolean;
}

/** Append-only room event — the replayable record (§2.2). */
export interface FloorEvent {
  seq: number;
  at: number;
  type:
    | 'room/registered'
    | 'binding/claimed'
    | 'contract/changed'
    | 'bid/created'
    | 'bid/replaced'
    | 'bid/amended'
    | 'bid/cancelled'
    | 'bid/staled'
    | 'bid/substituted'
    | 'grant/offered'
    | 'grant/accepted'
    | 'grant/declined'
    | 'grant/continued'
    | 'grant/released'
    | 'grant/revoked'
    | 'grant/expired'
    | 'book/restated'
    | 'acknowledged';
  data: Record<string, unknown>;
}
