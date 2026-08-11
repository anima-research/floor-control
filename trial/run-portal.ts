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

import { readFileSync } from 'node:fs';
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const hostTransport = new PortalTransport({
  url: rig.url,
  credsFile: 'trial/creds/floor-service.creds.json',
  roomChannelId: rig.roomChannelId,
  controlThreadId: rig.controlThreadId,
});
await hostTransport.connect();
const host = new FloorRoomHost(hostTransport, new FluidFairnessLogic({ leaseMs }), {
  tickMs: 1000,
  ledgerPath: `trial/runs/${stamp}.jsonl`,
});
host.start();
console.log(`floor-service live: room=${rig.roomChannelId} control=${rig.controlThreadId} lease=${leaseMs}ms`);

const bots: ScriptedBot[] = [];
for (let i = 1; i <= botCount; i++) {
  const name = `trial-bot-${i}`;
  const t = new PortalTransport({
    url: rig.url,
    credsFile: `trial/creds/${name}.creds.json`,
    roomChannelId: rig.roomChannelId,
    controlThreadId: rig.controlThreadId,
  });
  await t.connect();
  const bot = new ScriptedBot(t, `persona:${rig.personas[name]}`, {
    name,
    profile: i === 1 ? 'prepared' : 'talkative',
    thinkMs: 2000,
    reactMs: 500,
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
