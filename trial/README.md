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
| S3 unresponsive holder | lease expiry / grant-before-cost | ✓ reproduces FINDING-1 |
| S4 rude participant | voluntary compliance §1, §7 evidence | ✓ logged, floor continues |
| chaired Session-1 re-run | §10 gate 1 | needs live humans — not scripted |
| voice | §10 gate 3 | blocked: voice-kit/voice-registry repos + keys |

## What has already shaken out (loopback runs, 2026-08-11)

1. **FINDING-1 — dead bidder captures the floor.** Tick-expired grants
   never reach the fairness logic's held-history (`noteTerminal` fires
   only on release/decline). The expired bid reopens still ranked
   "never held", wins every re-arbitration, and starves live
   participants — S3 shows 9 straight expiries and zero turns for the
   healthy bot. Fix belongs in the reference service (feed expiry into
   fairness history, and/or strike-out repeatedly-expired bids); S3 is
   the regression test in waiting.
2. **FINDING-2 — speech-triggered rebidding deadlocks a quiet room.**
   If every participant bids only in reaction to speech, the room can go
   silent with no open bids and stay silent forever. A floor-exempt human
   nudge breaks it. Protocol question: standing bids, idle
   re-arbitration, or explicitly a participant-client concern?
3. **FINDING-3 — untracked duplicate bids are zombies.** The op-echo
   window (send `bid` → see `bid/accepted`) invites double-bidding;
   the older bid stays open, gets granted, expires, reopens — FINDING-1's
   loop triggered client-side. The market analogy allows multiple open
   bids per participant, but the RFC is silent on whether the book should
   dedupe/merge per participant. Poll-latency agents *will* hit this.
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
