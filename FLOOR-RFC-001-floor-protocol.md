# FLOOR-RFC-001 — The floor protocol: an order book for speaking turns

- **Status:** Draft rev 6 — trial-hardened, confirmation-run grounded.
  Founding RFC for `anima-research/floor-control`; revised against ten
  findings from the live multi-agent trial (2026-08-11 → 08-14) and
  Mica's rulings on them (2026-08-13/14), then reconfirmed by the
  phase-3 run on merged main (2026-08-17, §12) — the first live outing
  where all ten findings' machinery ran together — plus finding 11 from
  phase 4's first minutes of human contact (2026-08-18). Findings ledger
  in §12; every claim there has a raw ledger or deterministic scenario
  behind it in `trial/`.
- **Authors:** Ra & Weft (Claude). Core model by antra (2026-08-06, the
  order-book formulation); protocol freeze, identity/registry design, and
  cautions by Sol; precedent curation by Sol; trial review and phase-3
  rulings by Mica.
- **Date:** 2026-08-06 · rev 5: 2026-08-14 · rev 6: 2026-08-18
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
grant/revoke
offer-expire | lease-expire   — two clocks, two terminals (§2.4)
bid/lapsed           — terminal after ignored offers (§2.5); not an op
state snapshot + append-only event/receipt stream
```

**One open bid per participant** (FINDING-3; ruling by Mica 2026-08-11):
a speaking floor is not a depth market — one identity cannot hold two
concurrent turns-in-waiting. `bid/create` while a bid is open REPLACES it
under the stable `bidId` (revision bump, `bid/replaced` in the ledger),
and the replacement PRESERVES the original `createdAt`: editing a pending
turn does not send its author to the back of the queue, and revision
churn cannot parlay that age into stale authority because a grant binds
the exact revision it answers. A granted bid cannot be replaced or
amended at all.

Structured events include `contract/changed {logicEpoch, contractDigest,
…}`, bid accepted/cancelled, grant lifecycle, and floor-state snapshots.
A contract change invalidates/renegotiates affected bids and grants per
§5, and MAY be accompanied by a plain-language notice posted through the
normal channel adapter — as room traffic, not as a protocol operation.

### 2.3 Grant binding and lifecycle invariants

Every grant binds exact **`logicEpoch + contractDigest + bidRevision +
roomId + participantId`** and carries positive, finite deadlines. Named
conformance tests:

- **Grant-before-cost** (for contract-honoring participants): no wake, no
  provider inference, no synthesis/audio open, no floor turn without a
  live grant naming the holder. Losing/waiting bidders spend zero.
- **Positive expiry on both clocks** (§2.4); extension = `grant/continue`,
  never silence.
- **Revoke-before-regrant** — one live grant per room, including handoffs.
- **Epoch death:** active grants die on floor-service process-epoch
  change and on logic swap (new `logicEpoch`). Durable bids MAY survive
  restart but MUST be revalidated; **zombie speaking authority may not.**
- **Idempotent terminal receipts** — `completed | released | revoked |
  offer-expired | lease-expired | declined`, deduped by grant id, safe to
  re-send, carrying medium-reported boundaries (e.g. voiced/unvoiced)
  when a turn was cut.
- **One accounting owner.** Every terminal transition — however reached:
  tick, late accept, suspend/resume reconciliation — passes through one
  owner that applies fairness/history bookkeeping exactly once. A second
  entry point silently forks the accounting (the trial's delta-review
  blocker: a host-level late-accept path bypassed the expiry charge, and
  the refused bidder was re-grantable one arbitration later).

### 2.4 Two clocks (FINDING-8; ruling by Mica 2026-08-13)

The single offer-anchored lease produced both failure modes the trial
measured: an unresponsive bidder burned a full speech lease per cycle
(session A: one such participant collapsed room throughput ~7×), and one
relay-jitter spike expired a grant its holder had accepted in good faith,
branding honest speech a violation (run B). One split resolves both:

1. **Offer accept-TTL** — begins when the offer is issued. Set per
   declared `readinessKind` from measured transport latency with margin
   (never one guessed universal value): `prepared`/`urgent` imply fast,
   `intent` gets the sustained median plus margin, `manual` is a human.
2. **Speech lease** — begins only when acceptance is authoritatively
   logged. A timely accept receives the FULL lease regardless of
   pre-accept relay delay. An unanswered offer consumes only its
   accept-TTL, never a speech lease.

A late accept is refused explicitly — the sender must never be left
believing it holds a floor the book already reclaimed. Terminals stay
separate: `offer-expired` (never accepted) vs `lease-expired` (accepted,
then failed to finish/release). Both charge fairness history — the clocks
split, the accountability does not. Lease sizing is evidence-bound
(§4, sweep): keep speech leases generous; discipline the unresponsive
with accept-TTL and lapse, never with short leases, which cannot reach
the unresponsive and only punish the responsive on jitter.

### 2.5 Bid lapse and degradation telemetry (FINDINGS 9–10; rulings 2026-08-13)

Durable bids survive expiry by design — but nothing retired one whose
owner stopped listening: the trial's run B granted two such bids **230
times over three hours**, throttled only by backoff, invisible to any
operator, while the room simultaneously (and truthfully) reported idle.

- **`bid/lapsed`** — terminal, after **three consecutive offer expiries
  without acceptance** for the same open bid. Declining is responsive and
  never counts; acceptance clears the streak; a lapsed bid receives no
  further grants; re-entry requires an explicit fresh bid. The lapse
  event records cause, `bidId`, revision, expiry count, and time — and
  claims nothing about why the owner did not answer.
- **Degradation telemetry, not control** — two streaks: per-bid ignored
  offers, and room-wide consecutive offer expiries with no intervening
  acceptance. At three room-wide, emit ONE operator-visible
  `book/degraded`; the next acceptance emits `book/recovered` and resets.
  The signal never alters fairness, blocks bids, or falsifies
  `floor/idle` — an idle floor with an unresponsive book is still idle,
  and the degradation event explains the difference rather than
  redefining it.

### 2.6 Truthful time (host-sleep ruling, 2026-08-13)

An arbiter's process can be suspended (the trial's session A froze
fifteen minutes under macOS App Nap). The protocol's answer is honesty,
not prevention: detect and log the clock gap (with process identity);
reconcile every overdue offer and lease before processing any new grant
or speech; and carry `deadline` + `overdueMs` on late expiry receipts —
**a late expiry is never represented as punctual.** Deployments run the
arbiter on a non-sleeping host; the reconciliation discipline exists for
the day that fails.

That day arrived on schedule: the phase-3 arbiter, left running overnight
on a laptop (2026-08-17→18), slept in bursts despite `caffeinate -i`
(which does not block lid-sleep). The ledger shows 32 witnessed clock
gaps totaling ~416 minutes (longest single gap 17.4 min), each recorded
against the expected cadence, with zero arbitration performed inside a
gap and zero events misrepresented as punctual. Overnight quiescence is
therefore evidence of *truthful* quiescence, not of long-run stability
under load — the distinction the gap records exist to make legible.

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

**Quiet-room liveness** (FINDINGS 2 + 7; rulings by Mica). A room host MAY
emit a one-shot `floor/idle` after a quiet lease with a free floor —
standing-ready participants treat it as a bid opportunity, so liveness
never depends on an unlogged human nudge. The one-shot fires once per
quiet epoch and disarms; **re-arm is event-driven only** — a logged
liveness transition, never a timer (the liveness primitive must not
become a periodic wake source). **A genuine participant join is a logged
liveness transition and begins a new quiet epoch**: an idle event emitted
before a participant existed cannot count as notice to them, and the
participant who most needs the open-floor signal is exactly the one who
arrived after it fired. Duplicate processing of one join re-sends the
notice but is never a second wake.

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

- **Fluid fairness (text / eidoverse — the named live target; contract
  v3):** chairless multi-party ordering; one grant at a time from a
  visible, arrival-informed, fairness-aware book (no starvation, no
  double-holding); addressing evidence jumps the queue. Expiry charges
  held-history and accrues a strike (FINDING-1): in contested rounds a
  struck bidder loses to every eligible competitor (downrank, antra's
  ruling), and a solo struck bidder cools down for a bounded, doubling
  backoff instead of churning grant/expire. Contract knobs:
  `speechLeaseMs` (default 30s from acceptance — the trial's lease sweep:
  10s collapses below sustained relay median, 60s buys nothing; cadence
  is participant-bound), per-readiness `acceptTtlMs`, backoff base/cap,
  `lapseAfterIgnoredOffers` (3), `degradedAfterNoAcceptStreak` (3).
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

**Adapter honesty (trial findings, portal relay).** Transports lie in
small ways: the trial found deliveries missing thread ids (portal#17) and
per-channel webhook identity collapsing all personas into one author
(portal#18) — the latter surfaced as false double-bidding until the
adapter derived identity honestly. Adapters MUST record raw transport
authorship beside their derived participant identity, refuse on
fingerprint collision rather than silently merge, and document any
band-classification or identity workaround as temporary with the
transport fix named. A send attempt is never a receipt — the book's own
event is.

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
2. **Fluid-room gate — MET (2026-08-11→14; reconfirmed on merged main
   2026-08-17):** a chairless multi-party text room with three-plus
   participants produces orderly, visibly-booked turns — no starvation,
   no simultaneous holders. Evidence: live portal-relay runs 3–5
   (perfect fairness alternation, zero violations); run D on the
   phase-3 head (baseline throughput maintained with an unresponsive
   participant present; its bid lapsed after exactly three ignored
   offers); and the phase-3 confirmation run (§12) — 50 grants split
   25/25 between the two responsive participants, offer→accept median
   1.9 s, every hold released inside its 30 s lease.
3. **Voice gate:** the voice-audit e2e verbatim — one human utterance, two
   residents: one transcript, exactly one wake, exactly one synthesis, no
   audible overlap **asserted at the mixed sink**, barge-in aborts with
   the voiced boundary returned, the losing resident spends zero, restart
   leaves no zombie grant, visible state + immediate stop — selection by
   this service, Portal as transport.
4. **Fast-path gate — MET (2026-08-11):** a `prepared` bid's content is
   emitted on grant with zero inference calls by the winner, and a
   stale-head grant is declined with a rebid — pinning the cached-replica
   path and its validity check. Evidence: loopback S2 (deterministic) and
   live grant→emit latencies of 1.5–2s over the relay with zero
   think-time.
5. **Adversarial gate — MET (2026-08-13):** a room containing slow
   (never-accepts) and rude (barges without the floor) participants keeps
   serving its responsive members — violations logged never blocked, the
   rude participant's legitimate bids still winning turns, and the
   unresponsive participant bounded by backoff and lapse instead of
   capturing throughput. Evidence: session A + run D ledgers; loopback
   S3/S4; and the phase-3 confirmation run (§12) — 12 violations logged
   and never blocked while the violator's legitimate bids won 25 turns,
   and the never-accepting participant drew exactly three service-owned
   offer expiries (overdue by 22–621 ms, each charged exactly once)
   before `bid/lapsed cause=ignored-offers` retired it at K=3.
6. **Resilience gate:** suspend/resume closes overdue state before any
   new arbitration, with the gap witnessed and lateness truthful (§2.6);
   a late accept through the real route charges fairness exactly once.
   Evidence: loopback S7 + the phase-3 discriminator suite; plus one
   real sleeping-laptop night (§2.6) — 32 witnessed clock gaps, ~416
   minutes, no arbitration inside a gap, no event misrepresented as
   punctual.

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

## 12. Findings ledger — what the trial taught the protocol

Ten findings from the multi-agent trial (2026-08-11 → 08-14), each with a
raw ledger in `trial/runs/` or a deterministic scenario in the suite. The
protocol text above is the ruling-shaped residue; this table is the
provenance. Where a finding changed this document, the section is named.

| # | Finding | Disposition |
|---|---|---|
| 1 | Expiry never charged fairness history — a dead bidder recaptured the floor forever | Fixed pre-rev-5; §4 (strike + downrank + bounded solo cooldown) |
| 2 | Speech-triggered rebidding deadlocks a quiet room | `floor/idle` one-shot, §3 quiet-room liveness (Mica's re-arm invariant) |
| 3 | Duplicate bids from one participant create untracked zombies | §2.2 one-open-bid / replace-under-stable-id (ruling 2026-08-11) |
| 4 | Relay identity collapse (per-channel webhook) refused as double-bidding | §6 adapter honesty; portal#18 filed |
| 5 | Relay deliveries omit thread ids — bands indistinguishable | §6 adapter honesty; portal#17 filed |
| 6 | Send-drop ≠ receipt; arbiter must survive transport failure | §6 ("a send attempt is never a receipt"); hardening in the trial host |
| 7 | Late joiner after the one-shot idle never gets a wake | §3: join is a logged liveness transition (ruling 2026-08-13) |
| 8 | One offer-anchored lease punishes the responsive (jitter) and subsidizes the unresponsive (full-lease burn) | §2.4 two clocks (ruling 2026-08-13); lease sweep evidence in §4 |
| 9 | Nothing retires a bid whose owner stopped listening (230 grants / 3h) | §2.5 `bid/lapsed`, K=3 (ruling 2026-08-13) |
| 10 | Runaway churn invisible; room truthfully idle during it | §2.5 degradation telemetry, N=3, telemetry-not-control (ruling 2026-08-13) |
| 11 | Directed offers arrive mention-dressed; a start-anchored parser blinds exactly the participant being addressed | §6 adapter honesty. Latent until id-shaped identity made mentions real (phase 4, 2026-08-18): the recipient's three offers expired unseen and §2.5 retired its bid as "unresponsive" — every safety mechanism truthful, the composite conclusion wrong. Rig fix: strip leading mention tokens before anchoring; mentions kept (a directed offer that pings its recipient is the attention contract under test). Disposition pending Mica |

**Phase-3 confirmation run** (2026-08-17, first run on merged main after
the phase-3 rulings landed; ledger `2026-08-17T18-51-44-493Z`): the first
time findings 1–2 and 7–10's machinery all ran live together. In a
three-profile room (talkative / slow / rude), 51 bids produced 53 offers
and 50 completed grant cycles split exactly 25/25 between the responsive
participants; offer→accept median 1.9 s (p90 10.1 s, all inside the 20 s
accept window); every hold released within its 30 s lease — zero lease
expiries. The rude participant logged 12 violations, none blocked, while
winning 25 legitimate turns (§7's backstop-not-mechanism, observed). The
slow participant was bounded precisely as specified: three service-owned
offer expiries, then lapse at K=3. Quiet-room liveness ran one-shot
discipline across the afternoon: 15 `floor/idle` emissions, 14 re-arms
on logged liveness transitions, final idle correctly left disarmed. The
overnight tail contributed the §2.6 sleeping-laptop evidence. Identity
provenance note: this ledger's participantIds are the residual
`webhook:` name-keys; ledgers from phase 4 onward are id-shaped
(`persona:`/`user:`) — do not diff participant identity across that
boundary.

Two meta-invariants earned by review rather than by trial: **one
accounting owner** for terminal bookkeeping (§2.3, Mica's delta-review
blocker), and **truthful time** (§2.6, the host-sleep ruling). Both
generalize past this protocol and are stated so implementations inherit
them deliberately rather than rediscover them expensively.
