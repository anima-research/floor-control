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
import { parseDuration } from './band.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const rig = JSON.parse(readFileSync(arg('rig', 'trial/rig.json'), 'utf8'));
const leaseMs = parseDuration(arg('lease', '30s')) ?? 30_000;
const botCount = Number(arg('bots', '2'));
// Two reactive bots sustain each other indefinitely (~4s/turn observed live)
// — unattended, that's thousands of messages against the relay. Scripted
// turns are budgeted; the host itself keeps arbitrating for live
// participants after the bots go quiet.
const maxTurns = Number(arg('max-turns', '25'));
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

const hostTransport = new PortalTransport({
  url: rig.url,
  credsFile: 'trial/creds/floor-service.creds.json',
  personaName: 'floor-service',
  roomChannelId: rig.roomChannelId,
  controlThreadId: rig.controlThreadId,
  onAnomaly: ledgerAnomaly,
});
await hostTransport.connect();
const host = new FloorRoomHost(hostTransport, new FluidFairnessLogic({ leaseMs }), {
  tickMs: 1000,
  ledgerPath,
});
host.start();
console.log(`floor-service live: room=${rig.roomChannelId} control=${rig.controlThreadId} lease=${leaseMs}ms`);

const bots: ScriptedBot[] = [];
for (let i = 1; i <= botCount; i++) {
  const name = `trial-bot-${i}`;
  const t = new PortalTransport({
    url: rig.url,
    credsFile: `trial/creds/${name}.creds.json`,
    personaName: name,
    roomChannelId: rig.roomChannelId,
    controlThreadId: rig.controlThreadId,
    onAnomaly: ledgerAnomaly,
  });
  await t.connect();
  const bot = new ScriptedBot(t, `persona:${rig.personas[name]}`, {
    name,
    profile: i === 1 ? 'prepared' : 'talkative',
    thinkMs: 2000,
    reactMs: 500,
    maxTurns,
  });
  await bot.start();
  bots.push(bot);
  console.log(`${name} joined (${i === 1 ? 'prepared' : 'talkative'})`);
}

process.on('SIGINT', () => {
  host.stop();
  console.log(
    `\nledger: trial/runs/${stamp}.jsonl · violations=${host.violations.length} · ` +
      bots.map((b, i) => `bot${i + 1}:turns=${b.turnsTaken}`).join(' '),
  );
  process.exit(0);
});
