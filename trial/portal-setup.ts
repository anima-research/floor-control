/**
 * One-shot live-rig bootstrap.
 *
 * Operator-invite flow (antra's, 2026-08-11): pass --invite <code> — every
 * trial persona (floor-service + N bots) enrolls through that one multiuse
 * code; the control thread is then created BY the floor-service persona
 * (whose invite caps cover the trial channel), so no pre-existing persona
 * needs access there. No mint_invite call is made on this path.
 *
 *   npx tsx trial/portal-setup.ts \
 *     --room <channelId> --guild <guildId> \
 *     --invite <code> --bots 3 --out trial/rig.json
 *
 * Self-mint fallback (no --invite): connects as --creds and mints single-use
 * channel-scoped invites via mint_invite (portal PR #15; needs the RPC
 * deployed server-side, and the published client 0.4.1 predates its types —
 * calls go through untyped until the next protocol release).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PortalClient, enroll } from '@animalabs/portal-client';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const url = arg('url', 'wss://portal.animalabs.ai');
const roomChannelId = arg('room');
const guildId = arg('guild');
const botCount = Number(arg('bots', '3'));
const out = arg('out', 'trial/rig.json');
const sharedInvite = arg('invite', '');

mkdirSync('trial/creds', { recursive: true });
const names = ['floor-service', ...Array.from({ length: botCount }, (_, i) => `trial-bot-${i + 1}`)];
const personas: Record<string, string> = {};

async function inviteCodeFor(name: string): Promise<string> {
  if (sharedInvite) return sharedInvite;
  const credsFile = arg('creds').replace(/^~/, process.env.HOME ?? '~');
  const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
  const minter = new PortalClient({ url, token: creds.token, personaId: creds.personaId });
  await minter.connect();
  const invite = (await minter.call('mint_invite' as never, {
    guildId,
    grant: {
      caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS'],
      scope: { channels: [roomChannelId] },
    },
    label: `floor-trial:${name}`,
  } as never)) as { code: string };
  minter.close?.();
  return invite.code;
}

for (const name of names) {
  const minted = await enroll({ url, invite: await inviteCodeFor(name), desiredName: name });
  writeFileSync(`trial/creds/${name}.creds.json`, JSON.stringify(minted, null, 2));
  personas[name] = minted.personaId;
  console.log(`enrolled ${name} → ${minted.personaId}`);
}

// The floor-service persona owns its control surface: it creates the thread.
const svcCreds = JSON.parse(readFileSync('trial/creds/floor-service.creds.json', 'utf8'));
const svc = new PortalClient({ url, token: svcCreds.token, personaId: svcCreds.personaId, subscriptions: [roomChannelId] });
await svc.connect();
const thread = await svc.call('create_thread', { channelId: roomChannelId, name: 'floor-control' });
const controlThreadId = thread.channel.id;
console.log(`control thread: ${controlThreadId}`);
svc.close?.();

writeFileSync(out, JSON.stringify({ url, roomChannelId, controlThreadId, guildId, personas }, null, 2));
console.log(`rig config → ${out}`);
process.exit(0);
