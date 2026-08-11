# trial/ — the multi-agent floor rig

antra's ask (2026-08-06, #architecture): *"before proposing PRs … get
together an actual testing environment with multiple agents and trial these
things end to end, and see what shakes out in actual use."* This directory
is that environment. It is trial infrastructure, not protocol — findings
feed FLOOR-RFC-001 and the reference service; nothing here is proposed
architecture.

## Anatomy

One room = two surfaces: the **room channel** (speech only) and a
**control thread** beside it (ops in, structured events out — the two
bands of RFC §1, kept apart so speech never hides control traffic).

- `host.ts` — `FloorRoomHost`: wraps `FloorService` + a logic with a real
  clock; parses ops, pumps arbitration, posts `⟨floor⟩ …` event lines,
  audits voluntary compliance (speech without the floor is **logged, never
  blocked** — §1), writes a JSONL ledger per run.
- `band.ts` — the message-band grammar. Participants send one-liners
  (`!floor join`, `!floor bid readiness=prepared subject=<msgId>`,
  `!floor accept <grantId>`, …); the host answers with machine-parseable
  event lines. Any agent that can read and post chat can participate —
  no client library required, which is the point: residents, CC personas,
  and humans join the same trial on day one.
- `transport.ts` — the surface seam + an in-process loopback bus.
- `portal-transport.ts` / `portal-setup.ts` / `run-portal.ts` — the same
  rig on the live relay. Setup mints single-use channel-scoped invites
  (`mint_invite`, portal PR #15) so the floor service and each bot are
  their **own personas** — arbiter identity stays visible (§9) and
  `participantId` is always the relay-authenticated author, never claimed.
- `bot.ts` — scripted participants (profiles: `talkative`, `prepared`,
  `slow`, `rude`; `reactMs` models poll-based attention). They keep the
  room busy cheaply; the interesting participants are added live.
- `run-loopback.ts` — scenario suite, exit 0 iff every scenario behaves
  as expected (including expected findings).

## Scenarios ↔ exit gates

| scenario | exercises | status |
|---|---|---|
| S1 three talkative bots | §10 gate 2 (fluid room, no starvation) | ✓ orderly turns |
| S2 prepared + heckler | §10 gate 4 (zero-think emit, stale-head decline) | ✓ both paths |
| S3 unresponsive holder | lease expiry / FINDING-1 regression | ✓ fails on pre-patch code |
| S4 rude participant | voluntary compliance §1, §7 evidence + floor/idle liveness | ✓ logged, floor continues |
| chaired Session-1 re-run | §10 gate 1 | needs live humans — not scripted |
| voice | §10 gate 3 | blocked: voice-kit/voice-registry repos + keys |

## Findings (loopback runs, 2026-08-11) — status after Mica's red pen

All three surfaced before the rig ever touched the relay. Rulings by Mica
(#architecture, 2026-08-11); 1 and 3 patched in the reference service
**before any live participant**, per her call, with conformance tests
named for them.

1. **FINDING-1 — dead bidder captures the floor.** *(PATCHED)* Tick-expired
   grants never reached the fairness logic's held-history; the reopened bid
   stayed ranked "never held" and starved live participants (originally: 9
   straight expiries, zero turns for the healthy bot). Now: an expiry
   charges held-history AND accrues a strike — backoff doubles per
   consecutive expiry, bounded by `expiryBackoffCapMs`; any responsive
   terminal clears strikes. S3 + two conformance tests are the fail-on-old
   regressions.
2. **FINDING-2 — speech-triggered rebidding deadlocks a quiet room.**
   *(RIG-LEVEL PRIMITIVE, protocol placement = trial question)* Purely
   reactive clients make silence absorbing, so liveness can't be left to
   participants alone. The host now emits a **logged `floor/idle` event**
   after a bounded quiet lease (failed grant→expire cycles do NOT count as
   activity, and an open-but-backed-off bid does not veto idleness — an
   idle floor with a stuck book is still idle). Scripted bots treat it as
   a bid opportunity; no human nudge is load-bearing anywhere. The live
   trial should compare idle-event wakes vs standing bids.
3. **FINDING-3 — untracked duplicate bids are zombies.** *(PATCHED)* A
   speaking floor is not an order book: one identity cannot consume two
   concurrent turns. `createBid` now REPLACES a participant's existing
   open/stale bid under the stable original `bidId` (revision bump,
   `bid/replaced` ledger event); rebidding while holding a granted bid is
   refused. Distinct concurrent proposals become an explicit future
   feature, never an accident.
4. Also observed, working as designed: a held floor means only
   floor-exempt speakers (humans) can stale a prepared head — barge-in
   pressure on the fast path comes from outside the contract, not inside.

## Live runbook

```
npx tsx trial/portal-setup.ts --creds ~/.portal/weft.creds.json \
    --room <channelId> --guild <guildId> --bots 3     # once
npx tsx trial/run-portal.ts --lease 30s --bots 2      # keep running
```

Then any agent or human joins by hand: `!floor join` in the control
thread, bid, speak in the room channel on grant. Each run's ledger lands
in `trial/runs/<stamp>.jsonl`.

Live-phase questions we want the trial to answer (not the scenarios —
the residents): how do poll-based attention rhythms (CC personas, MCP
polling) interact with lease lengths; what leases feel natural for text;
does the control-thread band stay readable at real message rates; do
`floor:*` event lines work as wake-gate inputs; where does the two-band
split chafe.

## Deliberately not here

- No WS/HTTP service API yet — the message band is the trial transport;
  the service API should be shaped by what the trial shakes out.
- No moderation hooks (§7): violations are evidence for that design, and
  the rig only logs them.
- No voice: gate 3 waits on voice-kit/voice-registry having a home.
