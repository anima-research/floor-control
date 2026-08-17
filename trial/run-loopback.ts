/**
 * Loopback trial runs — the rig end-to-end with scripted participants, no
 * relay. Each scenario maps to an RFC §10 exit gate or a live-loop property
 * the conformance suite can't see (real clock, real latencies, misbehavior).
 *
 * Exit code 0 = every scenario behaved as EXPECTED (including expected
 * findings — a scenario that documents a known gap passes by reproducing it).
 *
 *   npx tsx trial/run-loopback.ts
 */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { FluidFairnessLogic } from '../src/logics.js';
import { FloorRoomHost } from './host.js';
import { ScriptedBot, sleep, type BotOptions } from './bot.js';
import { LoopbackBus, LoopbackTransport } from './transport.js';

interface Scenario {
  name: string;
  gate: string;
  run(): Promise<{ pass: boolean; detail: string }>;
}

function rig(opts: { leaseMs: number; bots: BotOptions[]; exemptIds?: string[]; ledger?: string }) {
  const bus = new LoopbackBus();
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    // Loopback latencies are ~ms, so the offer accept-TTL rides the same
    // fast clock as the speech lease (live defaults are relay-scale).
    new FluidFairnessLogic({
      speechLeaseMs: opts.leaseMs,
      acceptTtlMs: { intent: opts.leaseMs, prepared: opts.leaseMs, urgent: opts.leaseMs, manual: opts.leaseMs },
    }),
    {
      tickMs: 50,
      idleAfterMs: 1200,
      exemptIds: ['ra-human', ...(opts.exemptIds ?? [])],
      ledgerPath: opts.ledger,
    },
  );
  const bots = opts.bots.map(
    (b) => new ScriptedBot(new LoopbackTransport(bus, b.name, b.name), b.name, b),
  );
  return { bus, host, bots };
}

async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

const scenarios: Scenario[] = [
  {
    name: 'S1 fluid room — 3 talkative participants, orderly turns, no starvation',
    gate: 'RFC §10 gate 2',
    async run() {
      const { bus, host, bots } = rig({
        leaseMs: 2000,
        bots: [1, 2, 3].map((i) => ({ name: `bot-${i}`, profile: 'talkative' as const, maxTurns: 3, thinkMs: 30 })),
      });
      host.start();
      for (const b of bots) await b.start();
      await sleep(100);
      bus.post('ra-human', 'ra-human', 'room', 'seed: the room wakes up.');
      await until(() => bots.every((b) => b.turnsTaken >= 2), 15_000);
      host.stop();
      const turns = bots.map((b) => b.turnsTaken);
      const pass = bots.every((b) => b.turnsTaken >= 2) && host.violations.length === 0;
      return { pass, detail: `turns=${JSON.stringify(turns)} violations=${host.violations.length}` };
    },
  },
  {
    name: 'S2 prepared fast path — zero-think emission + stale-head decline',
    gate: 'RFC §10 gate 4',
    async run() {
      const { bus, host, bots } = rig({
        leaseMs: 2000,
        bots: [
          { name: 'chatty', profile: 'talkative', maxTurns: 4, thinkMs: 30 },
          // reactMs models a polling agent: chatty's speech lands inside the
          // window, re-arming the prepared text and staling the in-flight grant.
          { name: 'sniper', profile: 'prepared', maxTurns: 3, reactMs: 150 },
        ],
      });
      host.start();
      for (const b of bots) await b.start();
      // Humans speak freely (Session 1 exemption) — a heckle landing inside
      // the sniper's react window is the ONLY thing that can stale a head,
      // because a held floor blocks every contract-honoring speaker. Watch
      // the control band and heckle exactly once, on the sniper's first grant.
      let sniperBid: string | null = null;
      let heckled = false;
      bus.attach((m) => {
        if (m.surface !== 'control') return;
        const bid = /bid\/accepted bidId=(\S+) participant=sniper/.exec(m.text);
        if (bid && !sniperBid) sniperBid = bid[1];
        if (!heckled && sniperBid && m.text.includes('grant/offered') && m.text.includes(`bidId=${sniperBid}`)) {
          heckled = true;
          bus.post('ra-human', 'ra-human', 'room', 'heckle: wait, one more thing —');
        }
      });
      await sleep(100);
      bus.post('ra-human', 'ra-human', 'room', 'seed: opinions wanted.');
      const sniper = bots[1];
      await until(() => sniper.turnsTaken >= 2 && sniper.stalesDeclined >= 1, 20_000);
      host.stop();
      const fast = sniper.emitLatencies.filter((l) => l < 500).length;
      const pass = sniper.turnsTaken >= 1 && fast >= 1 && sniper.stalesDeclined >= 1;
      return {
        pass,
        detail: `fastEmits=${fast} latencies=${JSON.stringify(sniper.emitLatencies)} stalesDeclined=${sniper.stalesDeclined}`,
      };
    },
  },
  {
    name: 'S3 unresponsive holder — lease expires, expiry charges fairness history, live participant proceeds (FINDING-1 patched)',
    gate: 'grant-before-cost / FINDING-1 regression (fails on pre-patch code)',
    async run() {
      const { bus, host, bots } = rig({
        leaseMs: 400,
        bots: [
          { name: 'sleeper', profile: 'slow' },
          { name: 'alive', profile: 'talkative', maxTurns: 3, thinkMs: 30 },
        ],
      });
      host.start();
      for (const b of bots) await b.start();
      await sleep(100);
      bus.post('ra-human', 'ra-human', 'room', 'seed: anyone home?');
      await sleep(6000);
      host.stop();
      const expired = host.book.eventLog().filter((e) => e.type === 'grant/offer-expired' || e.type === 'grant/lease-expired').length;
      // Pre-patch this starved `alive` behind nine straight sleeper expiries
      // (expiry never reached fairness history, the reopened bid stayed
      // "never held"). Patched: the expiry charges held-history + a strike
      // backoff, so the live participant proceeds.
      const pass = expired >= 1 && bots[1].turnsTaken >= 2;
      return { pass, detail: `expired=${expired} aliveTurns=${bots[1].turnsTaken}` };
    },
  },
  {
    name: 'S4 rude participant — violations logged, floor uninterrupted',
    gate: 'voluntary compliance (§1) + §7 backstop evidence',
    async run() {
      const { bus, host, bots } = rig({
        leaseMs: 1500,
        bots: [
          { name: 'polite', profile: 'talkative', maxTurns: 3, thinkMs: 30 },
          { name: 'goblin', profile: 'rude', maxTurns: 3, thinkMs: 30 },
        ],
      });
      host.start();
      for (const b of bots) await b.start();
      await sleep(100);
      bus.post('ra-human', 'ra-human', 'room', 'seed: manners optional.');
      // FINDING-2, Mica's shape: no human nudge — quiet-room liveness comes
      // from the host's logged floor/idle event, which standing-ready bots
      // treat as a bid opportunity.
      await until(() => host.violations.length >= 1 && bots[0].turnsTaken >= 2, 15_000);
      host.stop();
      const pass = host.violations.length >= 1 && bots[0].turnsTaken >= 2;
      return { pass, detail: `violations=${host.violations.length} politeTurns=${bots[0].turnsTaken}` };
    },
  },
];

scenarios.push({
  name: 'S5 genuinely quiet room — floor/idle fires once per quiet epoch, re-arms only on logged liveness transition',
  gate: 'FINDING-2 invariant (Mica): liveness primitive must not become a periodic wake source',
  async run() {
    const { bus, host, bots } = rig({
      leaseMs: 1000,
      bots: [1, 2].map((i) => ({ name: `bot-${i}`, profile: 'talkative' as const, maxTurns: 1, thinkMs: 30 })),
    });
    host.start();
    for (const b of bots) await b.start();
    await sleep(100);
    bus.post('ra-human', 'ra-human', 'room', 'seed: say your piece.');
    await until(() => bots.every((b) => b.turnsTaken >= 1), 10_000);
    // Both bots are done (maxTurns=1, they ignore idle events): the room is
    // genuinely quiet. Across ~4 idle periods there must be exactly ONE
    // floor/idle emission — then silence, disarmed.
    const before = host.idleEmissions;
    await sleep(5000);
    const oneEpoch = host.idleEmissions - before === 1;
    // A liveness transition (human speech) re-arms with a logged cause, and
    // the next quiet epoch earns exactly one more emission.
    bus.post('ra-human', 'ra-human', 'room', 'back for a moment.');
    await sleep(2500);
    const rearmed = host.idleRearms.some((r) => r.cause === 'speech');
    const secondEpoch = host.idleEmissions - before === 2;
    host.stop();
    return {
      pass: oneEpoch && rearmed && secondEpoch,
      detail: `emissionsFirstQuiet=+${oneEpoch ? 1 : host.idleEmissions - before} rearmCauses=${JSON.stringify(host.idleRearms.map((r) => r.cause))} total=${host.idleEmissions}`,
    };
  },
});

scenarios.push({
  name: 'S6 late joiner after the one-shot idle fired — join is a logged liveness transition; the newcomer receives a fresh floor/idle (FINDING-7 fix; discriminator 1)',
  gate: 'Mica ruling 2026-08-13: an idle event emitted before a participant existed cannot count as notice to them; duplicate join processing is not a second wake',
  async run() {
    const { bus, host, bots } = rig({
      leaseMs: 1000,
      bots: [1, 2].map((i) => ({ name: `bot-${i}`, profile: 'talkative' as const, maxTurns: 1, thinkMs: 30 })),
    });
    host.start();
    for (const b of bots) await b.start();
    await sleep(100);
    bus.post('ra-human', 'ra-human', 'room', 'seed: say your piece.');
    await until(() => bots.every((b) => b.turnsTaken >= 1), 10_000);
    // Wait out the quiet lease: the one-shot fires, then disarms. The wide
    // window covers the honest slow path: a settled bot's leftover standing
    // bid can grant/expire-cycle through the lapse machinery (~3 backoff
    // rounds) before the room is genuinely quiet — FINDING-9's phenomenon
    // at loopback scale, resolved by bid/lapsed, then idle fires.
    await until(() => host.idleEmissions >= 1, 15_000);
    const emissionsAtJoin = host.idleEmissions;

    // A poll-based participant joins the quiet room AFTER the emission.
    // The join is a liveness transition: it re-arms the one-shot and begins
    // a new quiet epoch, so a fresh floor/idle reaches the newcomer, who
    // bids on it and takes the floor — no human nudge involved.
    const late = new ScriptedBot(new LoopbackTransport(bus, 'late-bot', 'late-bot'), 'late-bot', {
      name: 'late-bot', profile: 'talkative', maxTurns: 1, thinkMs: 30,
    });
    const lateTransport = new LoopbackTransport(bus, 'late-bot', 'late-bot');
    await late.start();
    // Duplicate processing of the same join (relay redelivery): idempotent,
    // never a second liveness transition.
    await lateTransport.sendControl('!floor join');
    const woke = await until(() => late.turnsTaken >= 1, 10_000);
    const freshEmission = host.idleEmissions === emissionsAtJoin + 1;
    const joinRearms = host.idleRearms.filter((r) => r.cause === 'participant/joined').length;

    host.stop();
    return {
      pass: woke && freshEmission && joinRearms === 1,
      detail: `wokeOnJoinRearmedIdle=${woke} emissionsAfterJoin=+${host.idleEmissions - emissionsAtJoin} ` +
        `joinRearms=${joinRearms} (2 join sends -> 1 liveness transition) rearmCauses=${JSON.stringify(host.idleRearms.map((r) => r.cause))}`,
    };
  },
});

scenarios.push({
  name: 'S7 suspend/resume — the clock gap is witnessed and every overdue offer reconciled before new speech is processed (host-sleep ruling; discriminator 9)',
  gate: 'Mica ruling 2026-08-13: detect/log the gap, reconcile overdue state first, never represent a late expiry as punctual, preserve process identity',
  async run() {
    const ledgerPath = joinPath(tmpdir(), `floor-s7-${Date.now().toString(36)}.jsonl`);
    const bus = new LoopbackBus();
    const host = new FloorRoomHost(
      new LoopbackTransport(bus, 'floor-service', 'floor-service'),
      new FluidFairnessLogic({
        speechLeaseMs: 1500,
        acceptTtlMs: { intent: 800, prepared: 800, urgent: 800, manual: 800 },
        expiryBackoffMs: 500,
        expiryBackoffCapMs: 1000,
      }),
      { tickMs: 50, idleAfterMs: 60_000, clockGapThresholdMs: 400, exemptIds: ['ra-human'], ledgerPath },
    );
    const sleeper = new ScriptedBot(new LoopbackTransport(bus, 'sleeper', 'sleeper'), 'sleeper', {
      name: 'sleeper', profile: 'slow', maxTurns: 5,
    });
    host.start();
    await sleeper.start();
    await sleep(100);
    bus.post('ra-human', 'ra-human', 'room', 'seed.');
    // The slow bot bids and is offered the floor (accept-TTL 800ms)…
    await until(() => host.book.liveGrant !== null, 5_000);
    // …then the host process "suspends": timers stop, the world moves on.
    host.stop();
    await sleep(1300); // > accept-TTL deadline AND > clockGapThresholdMs
    // First thing on wake is inbound speech. The host must witness the gap
    // and close the overdue offer BEFORE processing it.
    bus.post('ra-human', 'ra-human', 'room', 'good morning, room.');
    await sleep(300);

    const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rmSync(ledgerPath, { force: true });
    const gapIdx = rows.findIndex((r) => r.kind === 'clock-gap');
    const expiryIdx = rows.findIndex((r) => r.type === 'grant/offer-expired' || (r.kind === 'event' && r.data?.terminal === 'offer-expired'));
    const gapRow = rows[gapIdx];
    const expiryRow = rows[expiryIdx];
    const witnessed = gapIdx >= 0 && typeof gapRow.gapMs === 'number' && gapRow.gapMs > 400 && !!gapRow.processEpoch;
    const reconciledFirst = expiryIdx > gapIdx && expiryIdx >= 0;
    const truthful = (expiryRow?.data?.overdueMs ?? 0) > 0 && typeof expiryRow?.data?.deadline === 'number';
    return {
      pass: witnessed && reconciledFirst && truthful,
      detail: `gapWitnessed=${witnessed} (gapMs=${gapRow?.gapMs}, epoch=${gapRow?.processEpoch}) ` +
        `reconciledBeforeSpeechProcessing=${reconciledFirst} truthfulLateness=${truthful} (overdueMs=${expiryRow?.data?.overdueMs})`,
    };
  },
});

const results: Array<{ name: string; gate: string; pass: boolean; detail: string }> = [];
for (const s of scenarios) {
  process.stdout.write(`\n▶ ${s.name}\n`);
  const r = await s.run();
  results.push({ name: s.name, gate: s.gate, ...r });
  process.stdout.write(`  ${r.pass ? '✓ expected behavior' : '✗ UNEXPECTED'} — ${r.detail} [${s.gate}]\n`);
}

const failed = results.filter((r) => !r.pass);
process.stdout.write(`\n${results.length - failed.length}/${results.length} scenarios behaved as expected.\n`);
process.exit(failed.length ? 1 : 0);
