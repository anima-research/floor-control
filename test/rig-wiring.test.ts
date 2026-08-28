/**
 * Rig wiring conformance (Mica review 2026-08-28, seam 1): the send
 * budget belongs to the room, so EVERY outbound transport the wiring
 * produces — arbiter and bots — must share one SendBreaker. A budget
 * wired to the arbiter alone is a cap the automated senders walk
 * around; these tests hold the production wiring path itself to the
 * property, not a hand-built rig that happens to have it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PortalTransport } from '../trial/portal-transport.js';
import { SendBreaker } from '../trial/send-breaker.js';
import { wireTransportOptions } from '../trial/rig-wiring.js';

function makeRig(botNames: string[], sendBudget?: { maxSends: number; windowMs: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-wiring-'));
  for (const name of ['floor-service', ...botNames]) {
    writeFileSync(join(dir, `${name}.creds.json`), JSON.stringify({ personaId: `${name}-id`, token: 't' }));
  }
  const anomalies: Record<string, unknown>[] = [];
  const wiring = wireTransportOptions(
    { url: 'wss://example.invalid', roomChannelId: 'chan-room', controlThreadId: 'thread-control' },
    { botNames, onAnomaly: (e) => anomalies.push(e), sendBudget, credsDir: dir },
  );
  return { wiring, anomalies, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Stub the relay client so sends are observable without a connection. */
function stubClient(t: PortalTransport, sent: { persona: string; content?: string }[], persona: string) {
  (t as unknown as { client: { sendMessage(p: { content?: string }): Promise<{ messageId: string }> } }).client = {
    sendMessage: async (p) => {
      sent.push({ persona, content: p.content });
      return { messageId: `rm_chan-room_${sent.length}` };
    },
  };
}

test('wiring hands every transport the SAME breaker instance; none when no budget is asked for', () => {
  const budgeted = makeRig(['trial-bot-1', 'trial-bot-2'], { maxSends: 5, windowMs: 1000 });
  try {
    const { wiring } = budgeted;
    assert.ok(wiring.breaker instanceof SendBreaker);
    assert.equal(wiring.host.sendBudget, wiring.breaker, 'arbiter shares the room breaker');
    for (const bot of wiring.bots) {
      assert.equal(bot.sendBudget, wiring.breaker, `${bot.personaName} shares the room breaker`);
    }
  } finally {
    budgeted.cleanup();
  }
  const unbudgeted = makeRig(['trial-bot-1']);
  try {
    assert.equal(unbudgeted.wiring.breaker, undefined);
    assert.equal(unbudgeted.wiring.host.sendBudget, undefined);
    assert.equal(unbudgeted.wiring.bots[0].sendBudget, undefined);
  } finally {
    unbudgeted.cleanup();
  }
});

test('the room budget caps AGGREGATE output: a bot cannot spend outside the arbiter\'s window', async () => {
  const { wiring, anomalies, cleanup } = makeRig(['trial-bot-1'], { maxSends: 3, windowMs: 60_000 });
  try {
    const sent: { persona: string; content?: string }[] = [];
    const host = new PortalTransport(wiring.host);
    const bot = new PortalTransport(wiring.bots[0]);
    stubClient(host, sent, 'floor-service');
    stubClient(bot, sent, 'trial-bot-1');

    // Mixed senders spend the one window: 2 from the arbiter + 1 from
    // the bot exhausts maxSends=3.
    await host.sendControl('⟨floor⟩ grant/offered grantId=g1');
    await bot.sendRoom('bot turn 1');
    await host.sendControl('⟨floor⟩ floor/idle quietMs=1');
    assert.equal(sent.length, 3);

    // The bot's next send trips the ROOM breaker — under the pre-shared
    // wiring it would have sailed through on its own private budget.
    assert.equal(await bot.sendRoom('bot turn 2'), '');
    assert.equal(sent.length, 4, 'the final notice is the only extra send');
    assert.equal(sent[3].persona, 'trial-bot-1', 'the tripping transport carries the notice');
    assert.match(sent[3].content ?? '', /send budget exhausted/);

    // Silence now binds BOTH senders.
    assert.equal(await host.sendControl('⟨floor⟩ grant/offered grantId=g2'), '');
    assert.equal(await bot.sendRoom('bot turn 3'), '');
    assert.equal(sent.length, 4, 'hard silence across every transport');

    const trips = anomalies.filter((a) => a.kind === 'send-breaker-trip');
    assert.equal(trips.length, 1, 'one room, one trip receipt');
    assert.equal(trips[0].persona, 'trial-bot-1');
  } finally {
    cleanup();
  }
});
