/**
 * Late-joiner probe — the idle-event vs standing-bid comparison's instrument.
 *
 * Joins an ALREADY-QUIET room as a poll-based participant and takes one turn
 * when the floor comes to it. Everything measurable lands in the host's
 * ledger: the probe's `join` op timestamps entry, the next `grant/offered`
 * to it timestamps recovery. Run the same quiet room twice — host with
 * `--idle-after 60s` vs `--idle-after off` — and the delta between those two
 * ledger lines is the answer to "does floor/idle earn its keep."
 *
 *   npx tsx trial/late-joiner.ts [--rig trial/rig.json] [--bot trial-bot-3] [--wait 10m]
 *
 * --wait bounds the experiment: a probe still floorless when it elapses
 * exits 2 and prints NO-RECOVERY (that outcome IS the idle-off data point).
 */
import { readFileSync } from 'node:fs';
import { ScriptedBot } from './bot.js';
import { PortalTransport } from './portal-transport.js';
import { parseDuration } from './band.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const rig = JSON.parse(readFileSync(arg('rig', 'trial/rig.json'), 'utf8'));
const botName = arg('bot', 'trial-bot-3');
const waitMs = parseDuration(arg('wait', '10m')) ?? 600_000;

const transport = new PortalTransport({
  url: rig.url,
  credsFile: `trial/creds/${botName}.creds.json`,
  personaName: botName,
  roomChannelId: rig.roomChannelId,
  controlThreadId: rig.controlThreadId,
  onAnomaly: (e) => console.error('[anomaly]', JSON.stringify(e)),
});
await transport.connect();

const bot = new ScriptedBot(transport, `persona:${rig.personas[botName]}`, {
  name: botName,
  profile: 'talkative',
  thinkMs: 500,
  reactMs: 500,
  maxTurns: 1,
});
const joinedAt = Date.now();
await bot.start();
console.log(`${botName} joined quiet room at ${new Date(joinedAt).toISOString()}`);

const poll = setInterval(() => {
  if (bot.turnsTaken >= 1) {
    clearInterval(poll);
    console.log(`RECOVERED: first turn ${Date.now() - joinedAt}ms after join`);
    process.exit(0);
  }
  if (Date.now() - joinedAt > waitMs) {
    clearInterval(poll);
    console.log(`NO-RECOVERY: still floorless ${waitMs}ms after joining the quiet room`);
    process.exit(2);
  }
}, 500);
