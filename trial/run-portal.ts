/**
 * Live rig — host + scripted bots on the portal relay, using the identities
 * and control thread from portal-setup.ts. Scripted bots keep the room busy;
 * the interesting participants (residents, CC personas, humans) join the same
 * room by hand: `!floor join` in the control thread, speak in the channel.
 *
 *   npx tsx trial/run-portal.ts [--rig trial/rig.json] [--lease 30s] [--bots 2]
 *
 * Stop with ctrl-C; the ledger (trial/runs/<stamp>.jsonl) survives.
 */

import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { FluidFairnessLogic } from '../src/logics.js';
import { FloorRoomHost } from './host.js';
import { ScriptedBot } from './bot.js';
import { PortalTransport } from './portal-transport.js';
import { wireTransportOptions, makeShutdownOwner } from './rig-wiring.js';
import { parseDuration } from './band.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const rig = JSON.parse(readFileSync(arg('rig', 'trial/rig.json'), 'utf8'));
const leaseMs = parseDuration(arg('lease', '30s')) ?? 30_000;
const botCount = Number(arg('bots', '2'));
// Per-bot behavior profiles, comma-separated, assigned by bot index. The
// default reproduces the original two-bot shape exactly; extra bots beyond
// the list fall back to 'talkative'. e.g. --profiles talkative,slow,rude
const profiles = arg('profiles', 'prepared,talkative').split(',').map((p) => p.trim());
// Quiet-lease before the one-shot floor/idle emission. 'off' disables the
// emission entirely — the idle-event vs standing-bid comparison runs the
// same room both ways and measures late-joiner recovery.
const idleArg = arg('idle-after', '60s');
const idleAfterMs = idleArg === 'off' ? Number.POSITIVE_INFINITY : (parseDuration(idleArg) ?? 60_000);
// Two reactive bots sustain each other indefinitely (~4s/turn observed live)
// — unattended, that's thousands of messages against the relay. Scripted
// turns are budgeted; the host itself keeps arbitrating for live
// participants after the bots go quiet.
const maxTurns = Number(arg('max-turns', '25'));
// Humans ride exempt (per Session 1's "humans speak freely"): their speech
// moves the head and is never a violation. Comma-separated participantIds,
// e.g. --exempt user:252783081755246602,user:134390790938951680
const exemptIds = arg('exempt', '').split(',').map((s) => s.trim()).filter(Boolean);
// Send-rate breaker, `--send-budget 60/300s` shape (maxSends/window). Default
// OFF in the lab — scripted stress epochs legitimately exceed any
// social-channel cap; REQUIRED for any run pointed at a channel people
// live in (shadow-mode prerequisite).
const budgetArg = arg('send-budget', 'off');
const sendBudget = (() => {
  if (budgetArg === 'off') return undefined;
  const m = /^(\d+)\/(\d+)(s|m)$/.exec(budgetArg);
  if (!m) throw new Error(`--send-budget: want N/Ns|Nm (e.g. 60/300s), got ${budgetArg}`);
  return { maxSends: Number(m[1]), windowMs: Number(m[2]) * (m[3] === 'm' ? 60_000 : 1000) };
})();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// The ledger opens with a manifest naming the exact code under trial —
// a raw ledger without provenance is not a receipt (Mica, 2026-08-11).
const ledgerPath = `trial/runs/${stamp}.jsonl`;
mkdirSync('trial/runs', { recursive: true });
const git = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();
appendFileSync(
  ledgerPath,
  JSON.stringify({
    kind: 'manifest',
    at: Date.now(),
    branch: git('git rev-parse --abbrev-ref HEAD'),
    head: git('git rev-parse HEAD'),
    dirty: git('git status --porcelain') !== '',
    roomChannelId: rig.roomChannelId,
    controlThreadId: rig.controlThreadId,
    leaseMs,
    botCount,
    profiles: profiles.slice(0, botCount),
    idleAfterMs: Number.isFinite(idleAfterMs) ? idleAfterMs : 'off',
    exemptIds,
    sendBudget: sendBudget ?? 'off',
  }) + '\n',
);

// A stray rejection (relay hiccup, RPC timeout) is ledgered and survived —
// the arbiter process is the room's epoch; it dies on purpose or not at all.
process.on('unhandledRejection', (err) => {
  appendFileSync(ledgerPath, JSON.stringify({ kind: 'error', at: Date.now(), error: String(err) }) + '\n');
  console.error('unhandled rejection (survived):', err);
});

const ledgerAnomaly = (entry: Record<string, unknown>) =>
  appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');

// One shared breaker across every outbound transport — the budget caps
// the ROOM's aggregate output, not the arbiter's alone (the bots used
// to ride outside it: Mica review 2026-08-28, seam 1).
const wiring = wireTransportOptions(rig, {
  botNames: Array.from({ length: botCount }, (_, i) => `trial-bot-${i + 1}`),
  onAnomaly: ledgerAnomaly,
  sendBudget,
});

const hostTransport = new PortalTransport(wiring.host);
await hostTransport.connect();
const host = new FloorRoomHost(hostTransport, new FluidFairnessLogic({ leaseMs }), {
  tickMs: 1000,
  ledgerPath,
  idleAfterMs,
  exemptIds,
});
host.start();
console.log(`floor-service live: room=${rig.roomChannelId} control=${rig.controlThreadId} lease=${leaseMs}ms`);

const bots: ScriptedBot[] = [];
const botTransports: PortalTransport[] = [];
for (let i = 1; i <= botCount; i++) {
  const name = `trial-bot-${i}`;
  const t = new PortalTransport(wiring.bots[i - 1]);
  botTransports.push(t);
  await t.connect();
  const profile = (profiles[i - 1] ?? 'talkative') as import('./bot.js').BotProfile;
  const bot = new ScriptedBot(t, `persona:${rig.personas[name]}`, {
    name,
    profile,
    thinkMs: 2000,
    reactMs: 500,
    maxTurns,
  });
  await bot.start();
  bots.push(bot);
  console.log(`${name} joined (${profile})`);
}

// SIGINT and SIGTERM converge on one idempotent owner: the breaker's
// terminal receipt lands first (a container stop is SIGTERM — it must
// not lose the suppressed count), then transports close deliberately.
const shutdown = makeShutdownOwner({
  breaker: wiring.breaker,
  close: [async () => host.stop(), ...[hostTransport, ...botTransports].map((t) => () => t.close())],
  log: () =>
    console.log(
      `\nledger: trial/runs/${stamp}.jsonl · violations=${host.violations.length} · ` +
        bots.map((b, i) => `bot${i + 1}:turns=${b.turnsTaken}`).join(' '),
    ),
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
