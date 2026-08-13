# Floor trial phase 2 — adversarial profiles, idle comparison, lease sweep
2026-08-13. Rig head: d898b43 (feat/trial-rig). Ledgers raw in trial/runs/.

## Session A — talkative + slow + rude, lease 30s, 60min live
Ledger: 2026-08-13T17-30-45-712Z.jsonl (manifest head 9c0bee9, clean).

**A1. FINDING-1 fix validated at scale.** 7 full expiry cycles under `slow`.
Regrant intervals: 91s → 150s → 270s → ~290s → 522s — the bounded 2^n
cooldown, live. slow won only 6 of 23 post-first-expiry grants and never
captured the floor; other participants' fairness alternation preserved
throughout. bot2 finished with turns=0, exactly as profiled.

**A2. Compliance posture holds under sustained abuse.** 7 barges from `rude`,
every one ledgered as a violation, zero blocked, floor never interrupted
(S4's property at 1-hour scale). rude's *legitimate* bids kept winning clean
turns (9) — misbehavior charged to the record, not to the participant's
right to speak.

**A3. NEW — throughput collapse from one unresponsive participant (~7×).**
Run 5 baseline: ~3.1 grants/min. Session A: ~0.45 grants/min. Mechanism,
visible in the ledger: (1) each of slow's granted leases blocks the floor
for the full 30s; (2) expiry is deliberately not liveness (it must not
reset the idle clock), so a post-expiry room is dead air; (3) talkative
participants only bid on speech, so recovery waits for the one-shot
floor/idle (7 idle-rearm cycles drove the whole second half). One
unresponsive bidder turns a fluid room into an idle-machine-paced room.
→ Protocol question (Mica): should an offer carry its own ACCEPT DEADLINE,
shorter than the speech lease (accept within ~5s or the grant passes to
the next bidder)? readinessKind already encodes the expectation — prepared
implies instant, intent implies think-then-accept — so an accept-deadline
per readiness class fits the existing envelope. The current shape burns a
full lease per unresponsive cycle even when a live bidder is waiting.

**A4. Environment artifact, not protocol: the 15-minute frozen room.**
g27 offered 11:15:13 with leaseUntil=11:15:43 (book correct); expiry logged
11:30:46; send-drop of the offer line logged 11:31:03; nothing in between.
All timers froze together and caught up in one burst — the signature of
macOS suspending the background node process (App Nap) during the low-I/O
churn phase, then the socket send timing out on wake. The arbiter survived
its nap; the room froze with it. Deployment note: a laptop arbiter needs
`caffeinate -i` (sweep runs now use it) or a real host. Also argues for the
book emitting leaseUntil in every offer line (it does) so participants can
detect a frozen arbiter themselves.

## FINDING-7 — late joiner after the one-shot idle fired gets no wake, ever
Loopback S6 (deterministic, in the suite, 6/6): room settles → floor/idle
fires once and disarms → a poll-based participant joins → join updates no
book state, so it is not a logged liveness transition → no re-arm, no
emission, no bid, no grant, across arbitrarily many idle periods. Contrast
arm: one real speech line and the same participant bids and takes the floor
within a cycle — the participant was capable; the signal was missing.
The participant who most needs the open-floor signal is the one who arrived
after it fired.
→ Proposed semantic (Mica's re-arm invariant is the authority): `join` is a
logged liveness transition (authenticated, bounded per participant, cause
recorded in the ledger) and re-arms the one-shot. Keeps the
no-periodic-wake-source invariant intact — a re-arm still requires a new
participant event, never a timer.

## Run B — lease 10s: pathological, and three new findings
Ledger: 2026-08-13T18-36-59-556Z.jsonl (manifest head d898b43; dirty:true —
the S6 scenario edit was uncommitted at launch, committed since as b01d8dc;
blemish noted rather than hidden). Stopped by hand after 2h51m.

Census: 6 real bids → 236 grant offers, 232 expiries, 6 accepts. Bots
wedged at 3/15 turns each by t+87s; everything after was the book granting
two zombie bids alternately for three hours, rate-limited only by the
FINDING-1 backoff cap.

**F8 — one clock does two jobs, and both pathologies fall out.** The lease
runs from the OFFER. At 10s, one relay-jitter spike (offer→accept 8.5s at
g5) meant a participant accepted in good faith — the book logged
grant/accepted — and still expired mid-think. Its speech then landed as a
"violation" and its release hit a dead grant. Both of run B's violations
were honest participants punished by clock conflation (there was no rude
profile in the room). This is the same defect as session A's A3 in the
opposite direction: A3 shows unresponsive bidders burning a full lease
per cycle (offer-clock too LONG); F8 shows accepted holders losing their
turn to the offer-clock being too SHORT. One fix resolves both:
**offer carries its own short accept-TTL (per readinessKind); the speech
lease starts at ACCEPT.**

**F9 — zombie bids: durable-bid survival + client-side consumption = forever.**
Durable bids correctly survive expiry (Sol: "durable bids revalidate").
But once a client considers its bid consumed (turn done, state cleared),
nothing ever retires the book's copy: strikes downrank but never lapse a
bid, so b5/b6 were granted alternately 230 times to owners who had stopped
listening. Proposed: a bid whose owner ignores K consecutive grants (no
accept, no decline — distinct from declining, which is responsive)
transitions to a terminal `bid/lapsed`; re-entry requires an explicit
re-bid. Bounded zombie lifetime, and the lapse is itself a ledger event.

**F10 — runaway churn is invisible, and "idle" coexists with it.** Three
hours of grant/expire churn (~40 relay messages/hour of pure waste)
produced no operator signal. The room even emitted floor/idle DURING the
churn — open-but-ungrantable bids don't veto idleness (deliberate and
correct), so the room was simultaneously idle-for-humans and busy-with-
zombies. The book needs a cheap ops counter: N consecutive expiries with
zero intervening accepts → flag (not a behavior change, a visibility one).

**Sweep datum:** 10s lease is below the viable floor for poll-latency
participants on this relay: accept+think+speak+release spans ~5–9s with
jitter, so normal turns intermittently die (4 clean turns, then collapse
on the first jitter spike). Minimum viable lease for this participant
class ≈ 2×RTT + think-time + jitter margin ≈ 15s+.

## Run C — lease 60s: perfect health, and the sweep's conclusion
Ledger: 2026-08-13T21-33-21-268Z.jsonl (head b01d8dc, clean). 601s.
30/30 clean cycles (15 turns each), perfect alternation, 0 expiries,
0 violations, 0 structural errors. Throughput 3.0 grants/min — identical
to the 30s baseline.

**Sweep table:**
| lease | outcome | grants/min | expiries | violations |
|---|---|---|---|---|
| 10s | collapse at t+87s → 3h zombie churn | (6 real turns) | 232 | 2 (both false — F8) |
| 30s (run 5) | healthy | 3.1 | 0 | 0 |
| 60s | healthy | 3.0 | 0 | 0 |

**Conclusion.** Sustained median offer→accept on this relay is ~9.5–10s
regardless of lease (min ~1.5s; run 5 and run C agree). A 10s lease sits
below the median accept latency, so collapse is arithmetic. Above the
viability floor, lease length is nearly free — responsive holders release
early, so cadence is participant-bound, not lease-bound. Therefore: size
leases generously for jitter; protect against unresponsive holders with
F8's accept-TTL and F9's lapse, never with short leases. Short leases
don't discipline the unresponsive (they churn anyway, F9) — they punish
the responsive on jitter spikes (F8).

## Board after phase 2
- Fixes validated live: FINDING-1 backoff (7 cycles, bounded, no capture),
  FINDING-3 dedupe (no double-bids anywhere), compliance log-never-block
  (7 real + 2 false-positive violations all ledgered, floor uninterrupted).
- New findings 7–10 + the A3 throughput measurement + the sweep conclusion.
- Proposed protocol changes for Mica/antra (all RFC-shaped, none built):
  (1) offer accept-TTL per readinessKind + speech lease from accept [A3+F8];
  (2) bid/lapsed terminal after K ignored grants [F9];
  (3) join = logged liveness transition, re-arms the one-shot idle [F7];
  (4) ops counter for consecutive-expiry churn [F10].
- Environment: arbiter hosts must not nap (caffeinate/server) [A4].

## Session A raw numbers
- rows=174 span 3618s; grants 27; expiries 8 (7 under slow + g27's delayed
  logging); violations 7 (all rude); idle emissions/rearms 7; structural
  errors: 1 send-drop (the App Nap wake); identity-refusals 0.
- accept latencies (grant→accept): bot1 min 1.0s / med 1.3s; bot3 min 1.1s /
  med 2.3s — consistent with run-5's live-relay floor of ~1–2s.
