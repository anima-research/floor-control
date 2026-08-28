/**
 * Shadow runner conformance (Mica review 2026-08-28, seam 4): "stage 0
 * sends nothing" as executable evidence. The runner core is handed a
 * transport whose send methods are fully available and instrumented;
 * observed traffic and shutdown are driven through it; the assertion is
 * zero room/control sends. Mutation control: adding any send to
 * startShadow turns this red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { InboundMessage, RoomTransport } from '../trial/transport.js';
import { startShadow } from '../trial/shadow.js';

test('the runner core never touches a send path: observed traffic + shutdown produce zero room/control sends', async () => {
  const sends: string[] = [];
  let handler: ((m: InboundMessage) => void) | undefined;
  let closes = 0;
  const spy: RoomTransport = {
    locator: 'spy://trial/room-1',
    provenance: 'spy:test',
    onMessage(h) {
      handler = h;
    },
    async sendRoom(text) {
      sends.push(`room:${text}`);
      return 'sent';
    },
    async sendControl(text) {
      sends.push(`control:${text}`);
      return 'sent';
    },
    async close() {
      closes += 1;
    },
  };

  const records: Record<string, unknown>[] = [];
  const shadow = startShadow(spy, (e) => records.push(e as unknown as Record<string, unknown>));
  assert.ok(handler, 'the core subscribed to inbound traffic');

  // Live-shaped traffic on both surfaces, including a control line that
  // would provoke a reply from an arbiter — the shadow must not answer.
  handler!({ authorId: 'user:1', authorName: 'Someone', surface: 'room', messageId: 'm1', text: 'a human sentence', at: 1_000 });
  handler!({ authorId: 'user:2', authorName: 'Else', surface: 'control', messageId: 'm2', text: '!floor join', at: 2_500 });
  handler!({ authorId: 'user:1', authorName: 'Someone', surface: 'room', messageId: 'm3', text: 'another', at: 4_000 });

  await shadow.stop();

  assert.equal(sends.length, 0, 'zero room/control sends across observation and shutdown');
  assert.equal(closes, 1, 'shutdown closes the transport');
  assert.equal(records.length, 3, 'rhythm is still ledgered');
  // §9 by construction still holds through the core.
  for (const r of records) {
    assert.equal(
      Object.values(r).some((v) => typeof v === 'string' && /human sentence|another|floor join/.test(v)),
      false,
      'no record field carries message text',
    );
  }
  assert.equal(records[2].gapMs, 3_000, 'room-surface gap measured between room messages');
});
