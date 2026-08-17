/**
 * Post-#19 inbound classification — the rig's relay workarounds retired.
 *
 * portal PR #19 (deployed 2026-08-17) made the relay honest about threads
 * and persona attribution, so the transport's name-shape self-filter and
 * syntax-only band classification could retire. These tests pin the new
 * contract: container-first surfaces, id-shaped self-filtering, prefix rule
 * demoted to human tolerance, and the residual `webhook:` last-resort
 * identity keeping its collision refusal.
 *
 * No relay connection: toInbound() is driven with synthetic deliveries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalTransport } from '../trial/portal-transport.js';

const ROOM = 'chan-room';
const CONTROL = 'thread-control';
const MY_PERSONA = 'weft-test';

function makeTransport(anomalies: Record<string, unknown>[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-pt-'));
  const credsFile = join(dir, 'creds.json');
  writeFileSync(credsFile, JSON.stringify({ personaId: MY_PERSONA, token: 't' }));
  const t = new PortalTransport({
    url: 'wss://example.invalid',
    credsFile,
    personaName: 'Weft',
    roomChannelId: ROOM,
    controlThreadId: CONTROL,
    onAnomaly: (e) => anomalies.push(e),
  });
  return { t, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;
function delivery(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `rm-${seq}`,
    nativeId: `dm-${seq}`,
    channelId: ROOM,
    content: 'hello room',
    createdAt: new Date(1_786_990_000_000 + seq).toISOString(),
    author: { kind: 'persona', personaId: 'other-bot', displayName: 'Other' },
    ...over,
  };
}

test('control-thread traffic is control by container, no prefix needed', () => {
  const { t, cleanup } = makeTransport();
  try {
    const m = t.toInbound(delivery({ threadId: CONTROL, content: 'no prefix here' }));
    assert.equal(m?.surface, 'control');
  } finally {
    cleanup();
  }
});

test('a !floor line typed in the room channel still reaches the arbiter (human tolerance)', () => {
  const { t, cleanup } = makeTransport();
  try {
    const m = t.toInbound(delivery({ content: '!floor join', author: { kind: 'user', userId: 'u-ra', displayName: 'Ra' } }));
    assert.equal(m?.surface, 'control');
    assert.equal(m?.authorId, 'user:u-ra');
  } finally {
    cleanup();
  }
});

test('plain room speech is room', () => {
  const { t, cleanup } = makeTransport();
  try {
    assert.equal(t.toInbound(delivery())?.surface, 'room');
  } finally {
    cleanup();
  }
});

test('an unrelated thread under the room channel is not the room', () => {
  const { t, cleanup } = makeTransport();
  try {
    assert.equal(t.toInbound(delivery({ threadId: 'thread-elsewhere' })), null);
  } finally {
    cleanup();
  }
});

test('own persona echo is filtered by id even when the send id was never learned', () => {
  const { t, cleanup } = makeTransport();
  try {
    // The echo-beats-REST race: message id unknown to sentIds, but the relay
    // attributes it to us.
    const m = t.toInbound(delivery({ author: { kind: 'persona', personaId: MY_PERSONA, displayName: 'Weft' } }));
    assert.equal(m, null);
  } finally {
    cleanup();
  }
});

test('a DIFFERENT persona sharing our display name is not filtered (the old name-shape rule would have eaten it)', () => {
  const { t, cleanup } = makeTransport();
  try {
    const m = t.toInbound(delivery({ author: { kind: 'persona', personaId: 'impostor', displayName: 'Weft', bot: true } }));
    assert.equal(m?.authorId, 'persona:impostor');
  } finally {
    cleanup();
  }
});

test('a foreign webhook falls to the last-resort name key, collision-refusing', () => {
  const anomalies: Record<string, unknown>[] = [];
  const { t, cleanup } = makeTransport(anomalies);
  try {
    const first = t.toInbound(delivery({ author: { kind: 'user', userId: 'wh-1', username: 'ghost', bot: true } }));
    assert.equal(first?.authorId, 'webhook:ghost');
    // Same derived id, different underlying shape → refused, reported.
    const second = t.toInbound(delivery({ author: { kind: 'persona', personaId: undefined, username: 'ghost', bot: true } }));
    assert.equal(second, null);
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].kind, 'identity-refusal');
  } finally {
    cleanup();
  }
});
