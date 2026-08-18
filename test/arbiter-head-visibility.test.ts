/**
 * FINDING-14 (epoch 2026-08-18T20-47): the listening banner is room speech
 * to every other participant — the prepared bot correctly bound its content
 * to it — but the arbiter self-filtered its own echo, so lastRoomMessageId
 * stayed null and every offer said head=none. The sole prepared bid then
 * declined stale-head into an unbounded ~6s re-offer loop, born two seconds
 * after launch, invisible to lapse (declines are engagement) and to
 * degradation telemetry. The arbiter must count its own room speech as the
 * room head.
 *
 * Also: generic op refusals now reach the ledger, not only the control band
 * (the epoch's failed human accept left no ledger trace of why).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { FluidFairnessLogic } from '../src/logics.js';
import { parseEvent } from '../trial/band.js';

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

function rig() {
  const bus = new LoopbackBus();
  const ledger: Record<string, unknown>[] = [];
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 1000 }),
    { tickMs: 25, idleAfterMs: 60_000 },
  );
  (host as unknown as { ledger(e: Record<string, unknown>): void }).ledger = (e) => ledger.push(e);
  const controlEvents = () =>
    bus.log
      .filter((m) => m.surface === 'control' && m.authorId === 'floor-service')
      .map((m) => parseEvent(m.text))
      .filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  return { bus, host, ledger, controlEvents };
}

test('the first offer carries the banner as head, not none (FINDING-14)', async () => {
  const { bus, host, controlEvents } = rig();
  host.start();
  try {
    assert.ok(
      await until(() => bus.log.some((m) => m.surface === 'room' && /listening/.test(m.text)), 2_000),
      'banner posted',
    );
    const banner = bus.log.find((m) => m.surface === 'room' && /listening/.test(m.text))!;
    // A prepared participant binds to the banner exactly as the live bot did.
    bus.post('bot-a', 'bot-a', 'control', '!floor join');
    await until(() => controlEvents().some((e) => e.type === 'joined'), 2_000);
    bus.post('bot-a', 'bot-a', 'control', `!floor bid readiness=prepared subject=${banner.messageId}`);
    assert.ok(
      await until(() => controlEvents().some((e) => e.type === 'grant/offered'), 2_000),
      'offer emitted',
    );
    const offer = controlEvents().find((e) => e.type === 'grant/offered')!;
    assert.equal(offer.fields.head, banner.messageId, 'offer head must be the banner, not none');
  } finally {
    host.stop();
  }
});

test('real speech arriving before the banner send resolves is not clobbered', async () => {
  const { bus, host } = rig();
  // Deliver speech synchronously-ish with start: the .then guard must keep
  // the newer real head.
  host.start();
  bus.post('ra-human', 'ra-human', 'room', 'first words');
  try {
    await until(() => bus.log.some((m) => /listening/.test(m.text)), 2_000);
    await new Promise((r) => setTimeout(r, 50));
    const speech = bus.log.find((m) => m.text === 'first words')!;
    const head = (host as unknown as { lastRoomMessageId: string | null }).lastRoomMessageId;
    assert.equal(head, speech.messageId, 'human speech processed after banner send wins the head');
  } finally {
    host.stop();
  }
});

test('a refused op reaches the ledger with its reason (op-error)', async () => {
  const { bus, host, ledger } = rig();
  host.start();
  try {
    bus.post('ra-human', 'ra-human', 'control', '!floor accept room#1#g999');
    assert.ok(
      await until(() => ledger.some((e) => e.kind === 'op-error'), 2_000),
      'op-error ledgered',
    );
    const err = ledger.find((e) => e.kind === 'op-error') as { op: string; participantId: string; reason: string };
    assert.equal(err.op, 'accept');
    assert.equal(err.participantId, 'ra-human');
    assert.ok(err.reason.length > 0, 'reason recorded');
  } finally {
    host.stop();
  }
});

test('portal send receipts return delivery-space ids; self-filter keeps the relay id (FINDING-14b)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PortalTransport } = await import('../trial/portal-transport.js');
  const dir = mkdtempSync(join(tmpdir(), 'floor-idspace-'));
  const credsFile = join(dir, 'creds.json');
  writeFileSync(credsFile, JSON.stringify({ personaId: 'weft-test', token: 't' }));
  const t = new PortalTransport({
    url: 'wss://example.invalid',
    credsFile,
    personaName: 'Weft',
    roomChannelId: 'chan-room',
    controlThreadId: 'thread-control',
  });
  (t as unknown as { client: { sendMessage(p: unknown): Promise<{ messageId: string }> } }).client = {
    sendMessage: async () => ({ messageId: 'rm_chan-room_1539388960416211105' }),
  };
  try {
    // The returned id must be the bare native snowflake — the space
    // deliveries use — never the rm_-prefixed send receipt.
    assert.equal(await t.sendRoom('banner text'), '1539388960416211105');
    // ...while self-filtering still recognizes the echo by its RELAY id.
    const echo = t.toInbound({
      id: 'rm_chan-room_1539388960416211105',
      nativeId: '1539388960416211105',
      channelId: 'chan-room',
      content: 'banner text',
      createdAt: new Date(1_786_990_000_000).toISOString(),
      author: { kind: 'persona', personaId: 'someone-else', displayName: 'X' },
    });
    assert.equal(echo, null, 'own echo must still be filtered by relay id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
