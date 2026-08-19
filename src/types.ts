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
  | 'substituted'
  /** A stale-head decline parks the exact revision (FINDING-14 family;
   *  ruling 2026-08-18): re-offering it against the same head is provably
   *  futile. Eligibility returns on head advance or participant
   *  reaffirmation; queue age is preserved; fairness is never charged for
   *  a correct refusal. */
  | 'suspended'
  /** Terminal: the owner ignored three consecutive offers (no accept, no
   *  decline — declining is responsive). A lapsed bid receives no further
   *  grants; re-entry requires an explicit fresh bid. The lapse records
   *  facts, not motive — it never claims the participant departed.
   *  (Trial FINDING-9; ruling by Mica 2026-08-13, K=3.) */
  | 'lapsed';

export interface Bid extends BidEnvelope {
  state: BidState;
  /** Consecutive offers this bid's owner let expire unanswered. Cleared by
   *  acceptance; untouched by decline (responsive); reset on replace. */
  ignoredOffers: number;
  /** The head this revision was declared stale against (state 'suspended'
   *  only); null = the offer carried no known head. */
  suspendedOnHead?: string | null;
}

/** §2.3 — a grant binds the exact bid revision it answers.
 *
 *  Two clocks (trial FINDING-8; ruling by Mica 2026-08-13): the OFFER
 *  carries an accept-TTL from issue; the SPEECH LEASE begins only when
 *  acceptance is authoritatively logged. A timely accept receives the full
 *  speech lease regardless of pre-accept relay delay; an unanswered offer
 *  consumes only its accept-TTL, never a whole speech lease. */
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
  /** Accept-TTL deadline, counted from offer issue. */
  acceptBy: number;
  /** Speech-lease duration applied at acceptance. */
  speechLeaseMs: number;
  /** The operative deadline — positive, finite, always (§2.3). Equals
   *  acceptBy while offered; becomes acceptedAt + speechLeaseMs on accept. */
  leaseUntil: number;
  state: 'offered' | 'accepted' | 'terminal';
}

export type TerminalState =
  | 'completed'
  | 'released'
  | 'revoked'
  /** Never accepted: the offer's accept-TTL elapsed. */
  | 'offer-expired'
  /** Accepted, then the holder failed to finish/release within the lease. */
  | 'lease-expired'
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
    | 'grant/offer-expired'
    | 'grant/lease-expired'
    | 'bid/lapsed'
    | 'bid/suspended'
    | 'bid/reactivated'
    /** A service invariant failed (e.g. an offer reached a suspended
     *  revision). Distinct from degradation telemetry: this is the book
     *  reporting itself, loudly. */
    | 'book/invariant'
    /** Telemetry, not control (FINDING-10, N=3): three consecutive offer
     *  expiries with no intervening acceptance. Emitted once per episode;
     *  the next acceptance emits book/recovered. Never alters fairness,
     *  blocks bids, or falsifies floor/idle. */
    | 'book/degraded'
    | 'book/recovered'
    | 'book/restated'
    | 'acknowledged';
  data: Record<string, unknown>;
}
