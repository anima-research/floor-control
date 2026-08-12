/**
 * Claim an invite for an EXISTING persona — augments its caps with the
 * invite's grant (relay-side applyInviteAugment). Used to give Weft access
 * to the trial channel through the same operator-provided multiuse code the
 * trial personas enroll with. The code itself never gets posted anywhere.
 *
 *   npx tsx trial/claim-invite.ts --creds ~/.portal/weft.creds.json --code <invite>
 */

import { readFileSync } from 'node:fs';
import { PortalClient } from '@animalabs/portal-client';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`missing --${name}`);
}

const credsFile = arg('creds').replace(/^~/, process.env.HOME ?? '~');
const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
const client = new PortalClient({
  url: process.env.PORTAL_URL ?? 'wss://portal.animalabs.ai',
  token: creds.token,
  personaId: creds.personaId,
});
await client.connect();
// claim_invite may postdate the published client's RpcMethods typing
// (portal#12 lag) — same untyped-call treatment as mint_invite in setup.
const result = await client.call('claim_invite' as never, { code: arg('code') } as never);
console.log('claimed:', JSON.stringify(result, null, 2));
client.close?.();
process.exit(0);
