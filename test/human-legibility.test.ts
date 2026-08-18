/**
 * Human legibility minimums (phase-4 findings, 2026-08-18 afternoon).
 *
 * Two ways the floor was invisible to exactly the humans it was inviting:
 *
 * 1. Directed offers never pinged `user:` participants — the mention branch
 *    was persona-only, so a human's offer was a bare control-thread line
 *    with a 20s TTL (the live g4 expiry was a never-seen offer, not a
 *    decline). Fix: dress user-directed lines with an inline `<@id>` token,
 *    which the relay resolves into a real mention (probed live).
 *
 * 2. From the room channel, a freshly (re)started arbiter is
 *    indistinguishable from a dead one; ops sent into a restart gap vanish
 *    without trace (a live join+speech fell into the seven minutes between
 *    epoch stop and relaunch). Fix: the host banners the humans' band the
 *    moment listening begins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PortalTransport } from '../trial/portal-transport.js';
import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { FluidFairnessLogic } from '../src/logics.js';
import { parseEvent } from '../trial/band.js';

type SendParams = { content?: string; mentionPersonaIds?: string[]; threadId?: string };

function makeTransport() {
  const dir = mkdtempSync(join(tmpdir(), 'floor-hl-'));
  const credsFile = join(dir, 'creds.json');
  writeFileSync(credsFile, JSON.stringify({ personaId: 'weft-test', token: 't' }));
  const t = new PortalTransport({
    url: 'wss://example.invalid',
    credsFile,
    personaName: 'Weft',
    roomChannelId: 'chan-room',
    controlThreadId: 'thread-control',
  });
  const sent: SendParams[] = [];
  (t as unknown as { client: { sendMessage(p: SendParams): Promise<{ messageId: string }> } }).client = {
    sendMessage: async (p: SendParams) => {
      sent.push(p);
      return { messageId: `sent-${sent.length}` };
    },
  };
  return { t, sent, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a user-directed control line is dressed with an inline user mention', async () => {
  const { t, sent, cleanup } = makeTransport();
  try {
    await t.sendControl('⟨floor⟩ grant/offered grantId=g bidId=b', 'user:252783081755246602');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '<@252783081755246602> ⟨floor⟩ grant/offered grantId=g bidId=b');
    assert.equal(sent[0].mentionPersonaIds, undefined);
    // The dressed line stays machine-readable — the F11 fix covers this form.
    const e = parseEvent(sent[0].content!);
    assert.equal(e?.type, 'grant/offered');
    assert.equal(e?.fields.grantId, 'g');
  } finally {
    cleanup();
  }
});

test('persona-directed lines keep the relay mention param and clean content', async () => {
  const { t, sent, cleanup } = makeTransport();
  try {
    await t.sendControl('⟨floor⟩ grant/offered grantId=g bidId=b', 'persona:trial-bot-1-db6bab');
    assert.equal(sent[0].content, '⟨floor⟩ grant/offered grantId=g bidId=b');
    assert.deepEqual(sent[0].mentionPersonaIds, ['trial-bot-1-db6bab']);
  } finally {
    cleanup();
  }
});

test('undirected and residual-webhook lines are sent undressed', async () => {
  const { t, sent, cleanup } = makeTransport();
  try {
    await t.sendControl('⟨floor⟩ floor/idle quietMs=60000 holder=none');
    await t.sendControl('⟨floor⟩ grant/offered grantId=g bidId=b', 'webhook:someone');
    for (const p of sent) {
      assert.ok(p.content!.startsWith('⟨floor⟩'));
      assert.equal(p.mentionPersonaIds, undefined);
    }
  } finally {
    cleanup();
  }
});

test('host start banners the room band: listening begins here, earlier ops were not seen', async () => {
  const bus = new LoopbackBus();
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 1000 }),
    { tickMs: 25, idleAfterMs: 10_000 },
  );
  host.start();
  try {
    await new Promise((r) => setTimeout(r, 50));
    const roomBanner = bus.log.find(
      (m) => m.surface === 'room' && m.authorId === 'floor-service' && /listening/.test(m.text),
    );
    assert.ok(roomBanner, 'the humans’ band must mark the moment listening begins');
    assert.match(roomBanner!.text, /not seen/);
  } finally {
    host.stop();
  }
});
