/**
 * Shadow-mode runner (rev 8 testing ladder, stage 0) — observe a live
 * channel, ledger rhythm metadata, send NOTHING.
 *
 *   npx tsx trial/run-shadow.ts --channel <channelId> [--thread <threadId>]
 *     [--creds trial/creds/floor-service.creds.json]
 *
 * Deliberately not a FloorRoomHost: there is no book, no arbitration, no
 * banner — and no send path is ever referenced. Run only with the target
 * channel's blessing and disclosure (see trial/LEDGER-CONTENT-AUDIT.md).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PortalTransport } from './portal-transport.js';
import { startShadow } from './shadow.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const channelId = arg('channel', '');
if (!channelId) throw new Error('shadow needs --channel <channelId>');
const threadId = arg('thread', '') || undefined;
const credsFile = arg('creds', 'trial/creds/floor-service.creds.json');
const rigUrl = (JSON.parse(readFileSync('trial/rig.json', 'utf8')) as { url: string }).url;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ledgerPath = `trial/runs/shadow-${stamp}.jsonl`;
mkdirSync('trial/runs', { recursive: true });
const git = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();
appendFileSync(
  ledgerPath,
  JSON.stringify({
    kind: 'manifest',
    mode: 'shadow',
    at: Date.now(),
    branch: git('git rev-parse --abbrev-ref HEAD'),
    head: git('git rev-parse HEAD'),
    dirty: git('git status --porcelain') !== '',
    channelId,
    threadId: threadId ?? null,
  }) + '\n',
);

const transport = new PortalTransport({
  url: rigUrl,
  credsFile,
  personaName: 'floor-shadow',
  roomChannelId: channelId,
  ...(threadId ? { controlThreadId: threadId } : {}),
  onAnomaly: (entry) => appendFileSync(ledgerPath, JSON.stringify(entry) + '\n'),
});

// All transport use goes through the tested runner core — this script
// adds only the manifest and the connection (shadow-runner conformance
// proves the core touches no send path).
const shadow = startShadow(transport, (entry) => appendFileSync(ledgerPath, JSON.stringify(entry) + '\n'));

await transport.connect();
console.log(`shadow observing channel=${channelId} → ${ledgerPath} (no sends, ever)`);

// SIGINT and SIGTERM converge; re-entry is a no-op.
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void shadow.stop().finally(() => {
    console.log(`shadow closed; ledger ${ledgerPath} survives.`);
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
