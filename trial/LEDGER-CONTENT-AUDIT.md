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
| `speech-rhythm` (shadow) | at, authorId, messageId, byte length, surface, thread presence | metadata — see below |

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
never sends: it holds no reference to the transport's send methods, and
the run manifest declares `mode: 'shadow'`.

Remaining before a live-channel shadow run is *social*, not technical:
target-channel choice, disclosure to its regulars, and read access for
the service persona — antra's blessing, all three.
