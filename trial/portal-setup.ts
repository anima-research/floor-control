/**
 * One-shot live-rig bootstrap. Run as an existing persona (e.g. Weft) with
 * caps on the trial room channel; it mints single-use invites (subset of the
 * minter's caps, mint_invite RPC), enrolls the floor-service persona + N
 * scripted bots, creates the control thread, and writes a rig.json the run
 * scripts consume. Nothing here touches channels beyond the one you name.
 *
 *   npx tsx trial/portal-setup.ts \
 *     --url wss://portal.animalabs.ai \
 *     --creds ~/.portal/weft.creds.json \
 *     --room <channelId> --guild <guildId> \
 *     --bots 3 --out trial/rig.json
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
const credsFile = arg('creds').replace(/^~/, process.env.HOME ?? '~');
const roomChannelId = arg('room');
const guildId = arg('guild');
const botCount = Number(arg('bots', '3'));
const out = arg('out', 'trial/rig.json');

const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
const client = new PortalClient({ url, token: creds.token, personaId: creds.personaId });
await client.connect();

const thread = await client.call('create_thread', { channelId: roomChannelId, name: 'floor-control' });
const controlThreadId = thread.channel.id;
console.log(`control thread: ${controlThreadId}`);

mkdirSync('trial/creds', { recursive: true });
const names = ['floor-service', ...Array.from({ length: botCount }, (_, i) => `trial-bot-${i + 1}`)];
const personas: Record<string, string> = {};
for (const name of names) {
  // mint_invite landed in portal PR #15 (2026-08-06); published
  // @animalabs/portal-client 0.4.1 predates its types (portal#12 lag), so
  // the call goes through untyped until the next protocol release.
  const invite = (await client.call('mint_invite' as never, {
    guildId,
    grant: {
      caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS'],
      scope: { channels: [roomChannelId] },
    },
    label: `floor-trial:${name}`,
  } as never)) as { code: string; expiresAt: string };
  const minted = await enroll({ url, invite: invite.code, desiredName: name });
  const file = `trial/creds/${name}.creds.json`;
  writeFileSync(file, JSON.stringify(minted, null, 2));
  personas[name] = minted.personaId;
  console.log(`enrolled ${name} → ${minted.personaId}`);
}

writeFileSync(
  out,
  JSON.stringify({ url, roomChannelId, controlThreadId, guildId, personas }, null, 2),
);
console.log(`rig config → ${out}`);
client.close?.();
process.exit(0);
