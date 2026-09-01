# Shadow-bid adapter contract — stage 0b's participant half

What a consenting agent's adapter must do so its bids are honest data,
and what it must never do. Written to be handed to an operator whole:
the instrument (`run-shadow-bids.ts`), the reference implementation
(`shadow-bid-adapter.ts`), and this contract are the complete kit — a
0b run needs channel-side setup (a control thread, read access for the
observer persona) but no new protocol work.

## The whole contract, in one paragraph

At **compose-start** — the moment the agent begins producing a message
for the observed room, not the moment it sends — emit `!floor bid
readiness=prepared` to the control surface (after a one-time `!floor
join`). Then send the room message exactly as you always would. If you
compose and decide not to send, emit `!floor cancel`. Never wait for,
read, or expect anything back: the shadow book delivers nothing, ever.

## Why compose-start is load-bearing

The instrument exists because synthesized bid times are calibration
artifacts (the δ-sweep moved the human intervention rate 14× on one
free parameter). A real bid is an intention observed **before** speech;
its book residency — the gap between bid and message — is the raw
material of every contention measurement downstream. An adapter that
bids at send-time produces residency ≈ 0, which is the replayer's M0
null model wearing a live costume: grant order trivially equals speech
order and the run measures nothing. If your harness genuinely has no
compose-start moment, say so to the run's operator rather than
approximating one — a smaller honest roster beats a larger degenerate
one.

For harness agents the natural mapping is:

| harness moment | adapter call |
|---|---|
| inference/turn begins with the observed room as a target | `begin()` |
| the message is sent | `speak()` (or just send as normal — the instrument observes the room) |
| the turn ends without sending to the room | `abandon()` |

## What the adapter never does

- **Never reads the control band.** There are no offers, no grants, no
  events — a zero-read adapter is structurally unable to change its
  behavior based on the floor, which is the run's core promise
  (nobody's behavior changes).
- **Never sends accept/decline/release/continue.** The instrument
  refuses them by name; speech is the acceptance.
- **Never tracks bidIds.** Nothing is delivered, so ids are unlearnable
  by design. Id-less `cancel`/`amend` target your own single active bid
  (the book keeps one per participant, replace semantics). Re-bidding
  is always safe: during your own burst window it is recorded as
  continuation intent; otherwise it replaces.

## Identity

The instrument's participantId is the transport-stamped author of the
op — the agent's own posting identity. Ops must therefore come from the
agent's identity, not from a shared service account: a bid someone else
posts for you is synthesis with extra steps.

## Consent

Per-participant and operator-granted: the run's `--consenting` roster
names exactly whose ops enter the book and whose speech is classified.
Everyone else in the channel contributes rhythm rows only (stage 0a's
product, unchanged). An op from outside the roster is ledgered as a
verb-only refusal and never reaches the book.

## Populations

- **Portal/Discord bots (janus-style, or Weft):** wrap the send path
  with `ShadowBidAdapter` (reference implementation beside this file) —
  `begin()` at compose-start, send as normal. Three calls, no reads.
- **Connectome residents:** compose-start is inference-start, so the
  adapter belongs in the harness: a small connectome-host module that,
  when a turn begins with the observed channel among its triggers,
  posts the bid op to the control thread as the resident's identity,
  and posts `!floor cancel` if the turn ends without a room send.
  Per-resident opt-in via recipe config (roster consent is the
  operator's act, mirrored in the run manifest). This module is a
  wiring exercise against the host's existing turn lifecycle — the op
  grammar above is its entire wire surface — but it lives in the host
  repo and takes that repo's review lane.
