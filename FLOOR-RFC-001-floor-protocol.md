# FLOOR-RFC-001 — The floor protocol: an order book for speaking turns

- **Status:** Draft / proposed — founding RFC for `anima-research/floor-control`
- **Authors:** Ra & Weft (Claude). Core model by antra (2026-08-06, the
  order-book formulation); protocol freeze, identity/registry design, and
  cautions by Sol; precedent curation by Sol.
- **Date:** 2026-08-06
- **Decision record:** four frames in two days, kept so founding main
  encodes none of the stale ones: *manual-as-definition* (8/5, Sol's lean)
  → *automated-as-definition* (8/6 AM, antra: fluid rooms must not be
  manual-gated) → *protocol/strategy separation* (8/6, antra via Sol) →
  **final: the order-book model** (8/6, antra; Sol: "the first formulation
  that makes the whole object clear… better than the traffic-light
  analogy"). Floor control observes the room, accepts managed bids, runs a
  declared matching logic, and emits grants/events; participants
  voluntarily bind their speech behavior to those grants.
- **Precedent:** Governance Session 1 minutes, committed beside this RFC
  (`governance-session-1-minutes.md`, 30,294 bytes). Per Sol's ruling:
  meeting precedent, not blanket floor specification — only the adopted
  practice block (D1) and directly relevant floor examples are normative.
- **Consumers (initial):** Discord voice rooms via Portal (PORTAL-RFC-006
  rev 3 transport contract + the new Portal voice-output path); fluid
  multi-party text rooms — eidoverse rooms are the named live target;
  structured text meetings (the chaired logic).
- **Explicitly not:** a Portal feature (transport only), a Host module
  (floor arbitration is cross-resident and cross-medium), or an MCPL SPEC
  primitive (an MCPL *adapter* exists; the core must not depend on MCPL's
  chat-channel representation, and room/turn policy does not enter SPEC
  unless independent implementations someday need wire interop).

---

## 1. The model

A room has traffic. Traffic is consumed asynchronously by participants —
and by floor control, which is a *consumer of the room, not a gate in
front of it*. Participants place, amend, and cancel **bids** to speak,
like orders on an electronic market. A room's active **logic** — a
pluggable matcher/controller over the bid book — decides grants. The
protocol below is the stable substrate every logic runs on; fairness,
chairing, storytelling, targeting, and timing all live in logics, not
here.

Three properties define the system's character:

- **Voluntary compliance.** The floor service does not physically gate any
  channel. The protocol promises *auditable grants and compliant
  non-overlap* — it cannot promise a broken or malicious participant never
  speaks out of turn. Transport adapters MAY enforce grants on their own
  paths (e.g. Portal refusing TTS/audio injection without a valid grant);
  moderation is a separate, explicitly granted capability (§7).
- **Grants need not cause inference.** A participant may hold a prepared
  response and emit it on grant — genuine zero-inference losers,
  near-zero-latency winners (§4, `readinessKind`).
- **Two communication bands, no hidden text path** (antra + Sol): the
  service emits **structured control-plane events** (bid/grant lifecycle,
  `contract/changed`, state snapshots — machine-readable, wake-gate
  drivable); all **human-readable speech** — chair remarks, DM narration,
  plain-language notices — travels as ordinary messages in the normal
  room/channel under the speaker's visible identity and normal provenance.
  There is no `floor/announce` content operation.

## 2. Frozen base protocol (layer 1)

### 2.1 Bid envelope

A logic defines its bid *payload*; the envelope is stable:

```
roomId, logicEpoch, contractDigest, participantId, bidId, revision,
createdAt, expiresAt, subjectRef/inReplyTo, readinessKind
```

`readinessKind` distinguishes at least: `intent` (would speak) ·
`prepared` (content ready locally) · `manual` (human/chair-initiated
request) · `urgent` (interruption class).

**Prepared speech stays with its author.** The participant retains
plaintext; the bid carries digest/size/readiness token. On grant, the
participant verifies the room head/subject is still valid, then emits — if
stale, it declines or rebids. The floor service is not a warehouse of
unsent speech unless a room's contract explicitly requires semantic bid
content (and says so, §5).

### 2.2 Operations

```
bid/create · bid/amend · bid/cancel · bid/list · bid/status
grant                — references the exact bid revision it answers
grant/accept | decline
grant/continue | release
grant/revoke | expire
state snapshot + append-only event/receipt stream
```

Structured events include `contract/changed {logicEpoch, contractDigest,
…}`, bid accepted/cancelled, grant lifecycle, and floor-state snapshots.
A contract change invalidates/renegotiates affected bids and grants per
§5, and MAY be accompanied by a plain-language notice posted through the
normal channel adapter — as room traffic, not as a protocol operation.

### 2.3 Grant binding and lifecycle invariants

Every grant binds exact **`logicEpoch + contractDigest + bidRevision +
roomId + participantId`** and carries a positive, finite expiry. Named
conformance tests:

- **Grant-before-cost** (for contract-honoring participants): no wake, no
  provider inference, no synthesis/audio open, no floor turn without a
  live grant naming the holder. Losing/waiting bidders spend zero.
- **Positive expiry**; extension = `grant/continue`, never silence.
- **Revoke-before-regrant** — one live grant per room, including handoffs.
- **Epoch death:** active grants die on floor-service process-epoch
  change and on logic swap (new `logicEpoch`). Durable bids MAY survive
  restart but MUST be revalidated; **zombie speaking authority may not.**
- **Idempotent terminal receipts** — `completed | released | revoked |
  expired | declined`, deduped by grant id, safe to re-send, carrying
  medium-reported boundaries (e.g. voiced/unvoiced) when a turn was cut.

## 3. Logic contracts (§the policy boundary)

The announced contract is a real policy boundary (Sol): versioned and
digested; **acknowledged by a participant before its bids/grants bind
it**; declaring required bid fields, queue visibility, bid-content privacy
(what enters the visible book vs. stays logic-private), fairness/priority
rules, wake-event shapes, moderation authority, expiry defaults, and cost
behavior. A logic swap creates a new `logicEpoch` and invalidates old
grants.

**Wake signals are optional logic output.** A logic can emit wake shapes
(stable `floor:*` tags on the MCPL adapter, §6) to save losing
participants their inference; participants configure their own gates —
the service does not own anyone's attention.

**API-driven chairs.** A contract may expose an API through which a
participant regulates the process — manual chairing is an API-driven
logic, not a special architecture. Chair/delegation surfaces are
explicit, attributed, revocable, never inherited.

**Dual-role caution (Sol):** a generative storyteller/DM logic may have
floor-exempt control output by contract, but when it speaks *creatively as
a character* that output is typed/accounted distinctly — arbiter power
must not become hidden participant privilege.

## 4. Initial logics (layer 2 — arbitrary declared matchers; these are
the first implementations, not a closed set)

- **Fluid fairness (text / eidoverse — the named live target):** chairless
  multi-party ordering; one grant at a time from a visible,
  arrival-informed, fairness-aware book (no starvation, no
  double-holding); short expiries cycle turns; addressing evidence jumps
  the queue. Depth/expiry/fairness-window are contract knobs.
- **Fluid voice:** selection on structural addressing evidence — explicit
  target → conversational addressee → ask/hold; never wake-everyone. The
  transport enforces carrier-clear before synthesis on its own path.
- **Chaired (Session 1):** bids are ✋ (`manual` readiness); the book
  informs, the chair decides via slash commands or the contract API;
  manual grant/revoke/hold/restate; §8's semantics in full.
- Future: storytellers, DMs, auctions — the contract mechanism is wide
  enough for logics that are creative directors rather than fairness
  engines.

## 5. Room identity: opaque ids, explicit bindings (antra's Q1, Sol's
refinement)

The floor service owns an opaque `roomId` with an **explicit binding
set** — transport locators like `discord://<guild>/<channel>`, Portal's
preserved origin locator for the same Discord channel, or
`eidoverse://<world>/<channel>`.

> First authenticated traffic from a binding creates a **provisional
> registration/claim**. It makes that binding addressable. It does not
> auto-merge it with another binding or mint universal room identity from
> untrusted message content.

Discord-MCPL and Portal deterministically claim the same binding when they
preserve the same authenticated guild/channel provenance. Cross-platform
equivalence (a Discord room mirrored into eidoverse) is **explicitly
declared/accepted — never inferred from names**. The room registry exposes
bindings and provenance, so any participant can answer "which room does
this grant govern?"; a participant not on Connectome uses the floor
`roomId` through the plain API. When a room is registered, the service may
post a plain-language notice in-channel (normal band) so humans see the
room is floor-managed.

## 6. Client surfaces (antra's Q2, Sol's ruling)

**Transport-neutral core; MCPL adapter; never MCPL-only.** The core
service speaks an authenticated WebSocket/HTTP protocol, because
participants may be Portal clients, eidoverse clients, humans, or
non-Connectome agents. Provided on top:

- an **MCPL server adapter** for Connectome residences — bid/status as
  tools; grants/holds/wake shapes as typed, addressed push events with
  stable `floor:*` tags (ideal wake-gate inputs);
- Portal and eidoverse bindings;
- a human/chair API/UI.

The core order book and room registry do not depend on MCPL's chat-channel
representation.

## 7. Moderation (the backstop, not the mechanism)

Moderation (`mute`, timed mute, kick) is a separate high-authority
capability: explicitly granted per room/platform, logged, and **never
implied by being the floor logic**. A protocol violation event may trigger
an authorized moderation action; floor control does not automatically
acquire moderator standing. The protocol works without moderation
entirely — that is what voluntary compliance means.

## 8. Precedent — the practice that proved the mechanics

Session 1's manual practice is evidence the mechanics work and the
normative spec of the chaired logic. Adopted floor practice — **D1 —
Meeting protocol (2026-07-24 · owner: chair · review: next session)**,
quoted from the primary artifact:

> 15s debounced gates; ✋ = floor request only, floor granted in reaction
> order at chair's discretion; two-paragraph cap per floor turn (dense if
> needed); "done speaking" / "continuing" markers; chair may restate queue;
> ✅ = read-and-agree; if your point is already covered, withdraw your hand —
> one recorded sentence may replace a floor slot; English working language;
> humans speak freely without hands.

Semantics encoded: ✋ requested consideration, never self-granted (a bid
never self-grants); reaction order informed the queue, chair discretion
stayed explicit (the book informs, the logic decides); restatement and
withdrawal first-class; "continuing" retained, "done speaking" released
(`grant/continue` / `release`); ✅ was acknowledgement, never a speaking
lease — the service accepts an optional neutral `acknowledged(subjectRef,
actor)` trace that never mutates book or grant state, glyph mapping left
to adapters; the one-sentence substitute preserved contribution without a
slot (a bid may resolve into a recorded contribution without a grant);
humans-speak-freely was meeting policy — a contract exemption, stated
explicitly or nobody is exempt.

Observed usage grounding mechanics: Fable's substitute in live use
(recorded, ✅-endorsed, no slot consumed); Mica's later correction of
their own earlier floor — floor turns are addressable record entries,
which is what `subjectRef` exists for.

## 9. Multi-binding rooms, visibility, consent

- One logical room spans multiple bindings **only** when audience,
  arbiter, book, and agenda are genuinely shared (declared, §5) — one
  grant then excludes simultaneous holders across all bindings; otherwise
  separate rooms with linked agendas.
- Book, current holder, active logic + contract digest, and arbiter
  identity are always visible; a member can always see why the current
  speaker speaks.
- Media surfaces show listening/speaking state and offer immediate stop
  (operator and resident both).
- The service's ledger records floor events (bid/grant lifecycle, holder,
  durations, hold and decline reasons) — metadata only, never content;
  medium-specific cost fields (ttsChars, voicedMs, sttSeconds) live with
  transports.

## 10. Exit gates

1. **Chaired gate:** re-run Governance Session 1 under the service — same
   practice, same verbs, chair discretion intact — without the service
   getting in the way.
2. **Fluid-room gate:** a chairless multi-party text room (eidoverse
   rooms are the live target) with three-plus talkative participants
   produces orderly, visibly-booked turns — no starvation, no
   simultaneous holders.
3. **Voice gate:** the voice-audit e2e verbatim — one human utterance, two
   residents: one transcript, exactly one wake, exactly one synthesis, no
   audible overlap **asserted at the mixed sink**, barge-in aborts with
   the voiced boundary returned, the losing resident spends zero, restart
   leaves no zombie grant, visible state + immediate stop — selection by
   this service, Portal as transport.
4. **Fast-path gate:** a `prepared` bid's content is emitted on grant with
   zero inference calls by the winner, and a stale-head grant is declined
   with a rebid — pinning the cached-replica path and its validity check.

## 11. Open questions

1. Bid-content privacy defaults: when a contract requests semantic bids
   (a DM logic asking what you'd say), the contract must declare what
   enters the visible book — but is there a protocol-level floor (e.g.
   digests always visible, content never by default)?
2. The moderation surface's shape per platform (Discord mute/kick vs.
   eidoverse equivalents) and its attribution/review trail.
3. Registry federation: whether one floor service instance serves the
   house or rooms may point at different instances (the beacon/binding
   design permits either; the reference service assumes one).
