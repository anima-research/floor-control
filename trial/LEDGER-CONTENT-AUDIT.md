# Ledger content audit — §9 conformance (2026-08-19)

RFC §9 promises: *the service's ledger records floor events — metadata
only, never content.* This audit enumerates every record the trial rig
writes, classifies each field, and records the one repair it forced. It
exists so a run pointed at a channel people live in (rev 8 testing
ladder, stage 0) can cite its instrument's handling of what passes
through it, rather than asserting it.

## Record inventory (writers: `trial/host.ts`, `trial/run-portal.ts` via
## `onAnomaly`, `trial/shadow.ts`)

| kind | fields | class |
|---|---|---|
| `manifest` | git head/branch/dirty, channel ids, knobs, exemptIds, sendBudget | config metadata |
| `op` | at, participantId, verb, id, parsed args (ids, readiness, digests, reasons), raw relay attribution | metadata — op args are protocol values; a bid's `digest` is a hash, its `subject` a message id |
| `op-error` | op fields + refusal reason (protocol text) | metadata |
| `late-accept-refused` | ids + timing | metadata |
| `violation` | at, participantId, messageId, raw attribution — **no message text** | metadata |
| `event` | the book's own event stream (bid/grant lifecycle, telemetry) | metadata by construction |
| `idle` / `idle-rearm` / `clock-gap` | timings, causes | metadata |
| `identity-refusal` (anomaly) | derived id, fingerprint pair, raw attribution | metadata |
| `send-drop` (anomaly) | persona, error, **content handling below** | repaired |
| `send-breaker-trip` / `-reset` (anomaly) | persona, budget, timestamps, suppressed count | metadata |
| `send-breaker-final` (anomaly) | trip timestamp, suppressed count, notice settlement — shutdown-while-tripped snapshot | metadata |
| `send-breaker-notice-abandoned` (anomaly) | persona, timestamp — the trip notice never landed | metadata |
| `speech-rhythm` (shadow) | at, authorId, messageId, byte length, surface, thread presence | metadata — see below |
| `shadow-outcome` (shadow-bids) | at, participantId, messageId, speech class, contended flag, bid/grant ids | metadata — consenting participants ONLY, see below |
| `op-unconsented` (shadow-bids) | at, participantId, op verb — **args deliberately dropped** | metadata, minimized |

## The one repair

`send-drop` previously ledgered `contentPreview` — the first 80
characters of the outbound message. Every current sender is
machine-authored, but the field was structurally a content field in a
generic transport. Now band-aware (`previewOf`): protocol-band lines
(`⟨floor⟩` / `!floor`, mention-dressed or not) keep a bounded preview —
they *are* metadata; anything else is described as
`{contentBytes, contentWithheld: true}`. Pinned by test
(`test/send-breaker.test.ts`, §9 case).

## Identity

`raw` relay attribution (display names, user ids) is retained: §9 makes
holder identity and "why the current speaker speaks" *deliberately*
visible. Identity is not content. Rooms wanting pseudonymous ledgers
would do that at the participantId layer (§5 opaque ids), not by
redacting the ledger.

## Shadow mode (stage 0)

`trial/run-shadow.ts` records `speech-rhythm` entries only: timestamp,
author id, message id, **byte length**, band classification. No text
field exists in the record shape — the recorder cannot leak what it
never accepts (`trial/shadow.ts`, pinned by test). The shadow runner
never sends — and that claim is executable, not asserted: the runner
core (`startShadow`) is handed a transport whose send methods are fully
available, and conformance drives observed traffic plus shutdown
through it asserting zero room/control sends
(`test/shadow-runner.test.ts`; adding any send turns it red). The run
manifest declares `mode: 'shadow'`.

## Shadow bids (stage 0b, real-shadow-bids form)

`trial/run-shadow-bids.ts` extends the 0a record product with the
counterfactual book: `op`/`op-error` rows for CONSENTING participants'
bid-family ops (protocol values only, as in the live host), the book's
`event` stream (the would-be grant stream — never emitted anywhere), and
`shadow-outcome` rows classifying each consenting participant's speech
against the counterfactual floor. Two §9-plus obligations the design doc
names, both structural here:

- **Fairness rows only about people who opted in.** Non-consenting
  participants contribute `speech-rhythm` rows exactly as 0a records
  them — never a `shadow-outcome`. An op from a non-consenting id is
  ledgered as `op-unconsented` with its verb and NOTHING else (args
  dropped at the record boundary), and never reaches the book. Pinned by
  test (`test/shadow-bids.test.ts`, consent-gating case).
- **Zero-send on both surfaces, executable.** Same seam as 0a: the core
  accepts the full transport with sends available and only
  onMessage/close are ever touched; conformance drives the whole
  counterfactual lifecycle (ops, offers, expiries, idle, shutdown) and
  asserts zero sends. The run manifest declares `mode: 'shadow-bids'`
  and carries the consent roster.

Remaining before a live-channel shadow run is *social*, not technical:
target-channel choice, disclosure to its regulars (naming identifier
handling and, for 0b, the consent roster), and read access for the
service persona — antra's blessing, all three. A 0b run additionally
needs each consenting agent's operator to have opted in explicitly —
consent here is per-participant, not per-channel.
