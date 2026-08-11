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
    new FluidFairnessLogic({ leaseMs: opts.leaseMs }),
    { tickMs: 50, exemptIds: ['ra-human', ...(opts.exemptIds ?? [])], ledgerPath: opts.ledger },
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
    name: 'S3 unresponsive holder — lease expires; KNOWN GAP: expiry skips fairness history, dead bidder recaptures the floor',
    gate: 'grant-before-cost / FINDING-1',
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
      await sleep(4000);
      host.stop();
      const expired = host.book.eventLog().filter((e) => e.type === 'grant/expired').length;
      const starved = bots[1].turnsTaken === 0;
      // The gap REPRODUCING is this scenario's expected outcome: tick-expiry
      // never reaches FluidFairnessLogic.noteTerminal, the sleeper stays
      // "never held", its reopened bid wins every arbitration, and the live
      // participant starves. The fix belongs in the reference service; this
      // scenario is its regression test in waiting.
      const pass = expired >= 2 && starved;
      return { pass, detail: `expired=${expired} aliveTurns=${bots[1].turnsTaken} (starved=${starved})` };
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
      // FINDING-2 mitigation, human-shaped: speech-triggered rebidding means
      // an all-quiet moment deadlocks the room (everyone waits for someone
      // else to speak). A human nudge breaks it — the protocol question this
      // raises (standing bids? idle re-arbitration?) goes in the trial notes.
      const nudger = setInterval(() => bus.post('ra-human', 'ra-human', 'room', 'nudge: still here.'), 1500);
      await until(() => host.violations.length >= 1 && bots[0].turnsTaken >= 2, 15_000);
      clearInterval(nudger);
      host.stop();
      const pass = host.violations.length >= 1 && bots[0].turnsTaken >= 2;
      return { pass, detail: `violations=${host.violations.length} politeTurns=${bots[0].turnsTaken}` };
    },
  },
];

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
