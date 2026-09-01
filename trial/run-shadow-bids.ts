/**
 * Shadow-bids runner (rev 9 testing ladder, stage 0b live form) — real
 * bids from consenting agents into a book that grants nothing; the
 * counterfactual grant stream is ledgered, NOTHING is ever sent.
 *
 *   npx tsx trial/run-shadow-bids.ts --channel <channelId> \
 *     --consenting <id,id,...> [--thread <threadId>] \
 *     [--creds trial/creds/floor-service.creds.json]
 *
 * --consenting is the per-run consent roster: only these participants'
 * ops enter the book and only their speech draws outcome rows; everyone
 * else contributes rhythm rows exactly as stage 0a records them. Run
 * only with the target channel's blessing and disclosure — the stage-0
 * disclosure MUST name identifier handling and the consent roster (see
 * trial/LEDGER-CONTENT-AUDIT.md and rev 9's staged-path prerequisites).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { PortalTransport } from './portal-transport.js';
import { installShutdown } from './rig-wiring.js';
import { startShadowBids } from './shadow-bids.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const channelId = arg('channel', '');
if (!channelId) throw new Error('shadow-bids needs --channel <channelId>');
const consentingIds = arg('consenting', '').split(',').map((s) => s.trim()).filter(Boolean);
if (!consentingIds.length) {
  throw new Error('shadow-bids needs --consenting <id,id,...> — with no consenting participants, run stage 0a (run-shadow.ts)');
}
const threadId = arg('thread', '') || undefined;
const credsFile = arg('creds', 'trial/creds/floor-service.creds.json');
const rigUrl = (JSON.parse(readFileSync('trial/rig.json', 'utf8')) as { url: string }).url;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ledgerPath = `trial/runs/shadow-bids-${stamp}.jsonl`;
mkdirSync('trial/runs', { recursive: true });
const git = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();
const ledger = (entry: Record<string, unknown>) => appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
ledger({
  kind: 'manifest',
  mode: 'shadow-bids',
  at: Date.now(),
  branch: git('git rev-parse --abbrev-ref HEAD'),
  head: git('git rev-parse HEAD'),
  dirty: git('git status --porcelain') !== '',
  channelId,
  threadId: threadId ?? null,
  consentingIds,
});

const transport = new PortalTransport({
  url: rigUrl,
  credsFile,
  personaName: 'floor-shadow',
  roomChannelId: channelId,
  ...(threadId ? { controlThreadId: threadId } : {}),
  onAnomaly: (entry) => ledger(entry),
});

// All transport use goes through the tested runner core — this script
// adds only the manifest and the connection (shadow-bids conformance
// proves the core touches no send path on either surface).
const shadow = startShadowBids(transport, ledger, { consentingIds });

await transport.connect();
console.log(
  `shadow-bids observing channel=${channelId} consenting=[${consentingIds.join(', ')}] → ${ledgerPath} (no sends, ever)`,
);

// SIGINT and SIGTERM converge on one idempotent owner, registered
// through the tested seam — no bare process.on here.
installShutdown({
  signals: process,
  close: [() => shadow.stop()],
  log: () => console.log(`shadow-bids closed; ledger ${ledgerPath} survives.`),
  exit: (code) => process.exit(code),
});
