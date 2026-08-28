/**
 * Send-rate circuit breaker + §9 content minimization — the two
 * shadow-mode prerequisites (RFC rev 8, testing ladder stage 0).
 *
 * Blast-radius contract for channels people live in: when the rolling
 * window fills, ONE plain final notice is sent, then hard silence; every
 * suppressed send is counted (never individually ledgered — a runaway
 * must not flood the ledger through its own containment); the trip/reset
 * receipt pair carries the counts. Ledgered anomalies describe non-band
 * content by size only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PortalTransport } from '../trial/portal-transport.js';

function makeTransport(sendBudget?: { maxSends: number; windowMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-breaker-'));
  const credsFile = join(dir, 'creds.json');
  writeFileSync(credsFile, JSON.stringify({ personaId: 'weft-test', token: 't' }));
  const anomalies: Record<string, unknown>[] = [];
  const sent: { content?: string }[] = [];
  const t = new PortalTransport({
    url: 'wss://example.invalid',
    credsFile,
    personaName: 'floor-service',
    roomChannelId: 'chan-room',
    controlThreadId: 'thread-control',
    onAnomaly: (e) => anomalies.push(e),
    sendBudget,
  });
  (t as unknown as { client: { sendMessage(p: { content?: string }): Promise<{ messageId: string }> } }).client = {
    sendMessage: async (p) => {
      sent.push(p);
      return { messageId: `rm_chan-room_${sent.length}` };
    },
  };
  return { t, sent, anomalies, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the window fills → one final notice, then hard silence; trip and reset are ledgered with counts', async () => {
  const { t, sent, anomalies, cleanup } = makeTransport({ maxSends: 3, windowMs: 250 });
  try {
    for (let i = 0; i < 3; i++) await t.sendControl(`⟨floor⟩ floor/idle quietMs=${i}`);
    assert.equal(sent.length, 3, 'budget admits exactly maxSends');

    // Fourth send trips: suppressed, but the breaker's own notice goes out.
    assert.equal(await t.sendControl('⟨floor⟩ grant/offered grantId=g4'), '');
    assert.equal(sent.length, 4, 'the final notice is the only extra send');
    assert.match(sent[3].content ?? '', /send budget exhausted/);
    assert.equal(anomalies.filter((a) => a.kind === 'send-breaker-trip').length, 1);

    // Continued pressure: silence, counted.
    for (let i = 0; i < 5; i++) assert.equal(await t.sendControl('⟨floor⟩ spam'), '');
    assert.equal(sent.length, 4, 'hard silence under continued pressure');

    // Window drains → resume + reset receipt carrying the suppressed count.
    await new Promise((r) => setTimeout(r, 300));
    const id = await t.sendControl('⟨floor⟩ floor/idle quietMs=99');
    assert.notEqual(id, '', 'sends resume after the window drains');
    const resets = anomalies.filter((a) => a.kind === 'send-breaker-reset');
    assert.equal(resets.length, 1);
    assert.equal(resets[0].suppressed, 6, 'every suppressed send counted: the trip + five under silence');
  } finally {
    cleanup();
  }
});

test('no budget configured → no breaker (lab default)', async () => {
  const { t, sent, anomalies, cleanup } = makeTransport(undefined);
  try {
    for (let i = 0; i < 50; i++) await t.sendRoom(`turn ${i}`);
    assert.equal(sent.length, 50);
    assert.equal(anomalies.length, 0);
  } finally {
    cleanup();
  }
});

test('§9: a dropped protocol-band line keeps a preview; dropped room-band content is described by size only', async () => {
  const { t, anomalies, cleanup } = makeTransport(undefined);
  (t as unknown as { client: { sendMessage(): Promise<never> } }).client = {
    sendMessage: async () => {
      throw new Error('relay down');
    },
  };
  try {
    await t.sendControl('⟨floor⟩ grant/offered grantId=g1 bidId=b1');
    await t.sendRoom('a human-shaped sentence that must never enter the ledger');
    const drops = anomalies.filter((a) => a.kind === 'send-drop');
    assert.equal(drops.length, 2);
    assert.match(String(drops[0].contentPreview), /grant\/offered/, 'protocol band keeps its preview');
    assert.equal(drops[1].contentPreview, undefined, 'room band: no content field at all');
    assert.equal(drops[1].contentWithheld, true);
    assert.equal(drops[1].contentBytes, Buffer.byteLength('a human-shaped sentence that must never enter the ledger'));
  } finally {
    cleanup();
  }
});

test('trip-notice settlement is owned: a failed notice cannot land after the window resets (probe: one → notice-fail → after-reset → notice-success)', async () => {
  const { t, anomalies, cleanup } = makeTransport({ maxSends: 1, windowMs: 250 });
  // The notice's FIRST attempt fails; its retry (2s later, inside
  // rawSend) succeeds. Under the old fire-and-forget notice, the window
  // reset during those 2s and ordinary sends resumed before the notice
  // landed — Mica's probe order. The breaker now refuses to reset until
  // the notice settles, and the tripping call awaits that settlement.
  const sent: { content?: string }[] = [];
  let noticeAttempts = 0;
  (t as unknown as { client: { sendMessage(p: { content?: string }): Promise<{ messageId: string }> } }).client = {
    sendMessage: async (p) => {
      if (/send budget exhausted/.test(p.content ?? '') && ++noticeAttempts === 1) {
        throw new Error('relay hiccup on the notice');
      }
      sent.push(p);
      return { messageId: `rm_chan-room_${sent.length}` };
    },
  };
  try {
    assert.notEqual(await t.sendRoom('one'), '');
    assert.equal(sent.length, 1);

    // Trips; the call must not resolve while the notice is unsettled.
    const trip = t.sendRoom('two');

    // Window fully drained, notice still in flight (first attempt
    // failed, retry pending) — sending must NOT resume.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await t.sendRoom('after-reset?'), '', 'no resume while the notice is unsettled');
    assert.equal(sent.length, 1, 'nothing has reached the room since the trip');

    assert.equal(await trip, '');
    assert.match(sent[1]?.content ?? '', /send budget exhausted/, 'the tripping call resolved only after the notice settled');

    assert.notEqual(await t.sendRoom('resumed'), '', 'sending resumes once settled + drained');
    assert.deepEqual(
      sent.map((p) => (/send budget exhausted/.test(p.content ?? '') ? 'notice' : p.content)),
      ['one', 'notice', 'resumed'],
      'the notice strictly precedes every post-reset send',
    );
    const resets = anomalies.filter((a) => a.kind === 'send-breaker-reset');
    assert.equal(resets.length, 1);
    assert.equal(resets[0].suppressed, 2, 'the tripping send and the refused resume probe are both counted');
  } finally {
    cleanup();
  }
});

test('a notice that never lands is truthfully abandoned before the trip call returns', async () => {
  const { t, anomalies, cleanup } = makeTransport({ maxSends: 1, windowMs: 100 });
  // Ordinary sends land; only the notice finds the relay down — both of
  // its attempts fail, so it settles by abandonment, with a receipt.
  const sent: { content?: string }[] = [];
  (t as unknown as { client: { sendMessage(p: { content?: string }): Promise<{ messageId: string }> } }).client = {
    sendMessage: async (p) => {
      if (/send budget exhausted/.test(p.content ?? '')) throw new Error('relay down for the notice');
      sent.push(p);
      return { messageId: `rm_chan-room_${sent.length}` };
    },
  };
  try {
    assert.notEqual(await t.sendRoom('one'), '');
    assert.equal(await t.sendRoom('two'), '', 'the trip call resolves despite the undeliverable notice');
    assert.equal(anomalies.filter((a) => a.kind === 'send-breaker-notice-abandoned').length, 1);
    // Abandonment settles the notice: with the window long drained,
    // sending resumes rather than deadlocking behind a notice that
    // will never land.
    assert.notEqual(await t.sendRoom('three'), '');
    assert.equal(anomalies.filter((a) => a.kind === 'send-breaker-reset').length, 1);
    assert.deepEqual(sent.map((p) => p.content), ['one', 'three'], 'the abandoned notice never reached the room');
  } finally {
    cleanup();
  }
});

test('closing while tripped emits ONE bounded terminal receipt carrying the suppressed count — and no room send', async () => {
  const { t, sent, anomalies, cleanup } = makeTransport({ maxSends: 1, windowMs: 60_000 });
  try {
    await t.sendRoom('one');
    assert.equal(await t.sendRoom('two'), ''); // trips (notice goes out)
    assert.equal(await t.sendRoom('three'), ''); // suppressed
    assert.equal(sent.length, 2, 'one admitted send + the notice');

    await t.close();
    const finals = anomalies.filter((a) => a.kind === 'send-breaker-final');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].suppressed, 2, 'the tripping send and the suppressed send both survive shutdown');
    assert.equal(finals[0].noticeSettled, true);
    assert.equal(sent.length, 2, 'the terminal receipt is ledger-only — no room send');

    await t.close();
    assert.equal(anomalies.filter((a) => a.kind === 'send-breaker-final').length, 1, 'idempotent across repeated closes');
  } finally {
    cleanup();
  }
});

test('closing untripped emits no terminal receipt — the receipt marks state at risk, not routine shutdown', async () => {
  const { t, anomalies, cleanup } = makeTransport({ maxSends: 5, windowMs: 1000 });
  try {
    await t.sendRoom('one');
    await t.close();
    assert.equal(anomalies.filter((a) => a.kind === 'send-breaker-final').length, 0);
  } finally {
    cleanup();
  }
});

test('§9 by construction: a shadow record has no text field, only byte length', async () => {
  const { ShadowRecorder } = await import('../trial/shadow.js');
  const records: Record<string, unknown>[] = [];
  const rec = new ShadowRecorder((e) => records.push(e as unknown as Record<string, unknown>));
  rec.observe({
    authorId: 'user:1', authorName: 'Someone', surface: 'room',
    messageId: 'm1', text: 'private words that must not be recorded', at: 1000,
  });
  rec.observe({
    authorId: 'user:2', authorName: 'Else', surface: 'room',
    messageId: 'm2', text: 'reply', at: 4500,
  });
  assert.equal(records.length, 2);
  for (const r of records) {
    assert.equal(Object.values(r).some((v) => typeof v === 'string' && /private words|reply/.test(v)), false,
      'no field carries message text');
  }
  assert.equal(records[0].bytes, Buffer.byteLength('private words that must not be recorded'));
  assert.equal(records[0].gapMs, null);
  assert.equal(records[1].gapMs, 3500);
  assert.equal(records[1].transition, true);
});
