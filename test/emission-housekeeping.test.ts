/**
 * Control-band emission housekeeping (spotted live 2026-08-18, parked by
 * Mica for a dedicated pass): every amend appeared twice on the control
 * band — once as the host's direct ack (`r=`) and once as the book's
 * flushed event (`revision=`). One event should produce one line, in the
 * book's vocabulary. The bid ack keeps its direct line (it names the
 * participant, which bid/created does not) but drops the `r` shorthand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { FluidFairnessLogic } from '../src/logics.js';
import { parseEvent } from '../trial/band.js';

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

function rig() {
  const bus = new LoopbackBus();
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 1000 }),
    { tickMs: 25, idleAfterMs: 60_000 },
  );
  const controlLines = () =>
    bus.log
      .filter((m) => m.surface === 'control' && m.authorId === 'floor-service')
      .map((m) => parseEvent(m.text))
      .filter((e): e is NonNullable<ReturnType<typeof parseEvent>> => e !== null);
  return { bus, host, controlLines };
}

test('one amend produces exactly one bid/amended line, in book vocabulary', async () => {
  const { bus, host, controlLines } = rig();
  host.start();
  try {
    // Two bidders: the first bid draws the immediate offer, the second stays
    // open in the book — only open/stale bids amend (src/book.ts), which is
    // also the live shape (the morning amend landed between offer expiries).
    bus.post('bot-a', 'bot-a', 'control', '!floor join');
    bus.post('bot-b', 'bot-b', 'control', '!floor join');
    await settle();
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=intent');
    bus.post('bot-b', 'bot-b', 'control', '!floor bid readiness=prepared subject=m1');
    await settle();
    bus.post('bot-b', 'bot-b', 'control', '!floor amend b2 subject=m2');
    await settle();

    const amended = controlLines().filter((e) => e.type === 'bid/amended');
    assert.equal(amended.length, 1, 'exactly one bid/amended line per amend');
    assert.equal(amended[0].fields.revision, '2', 'book vocabulary: revision=');
    assert.equal(amended[0].fields.r, undefined, 'the r= shorthand is retired');
  } finally {
    host.stop();
  }
});

test('the bid ack survives, names the participant, and uses revision=', async () => {
  const { bus, host, controlLines } = rig();
  host.start();
  try {
    bus.post('bot-a', 'bot-a', 'control', '!floor join');
    await settle();
    bus.post('bot-a', 'bot-a', 'control', '!floor bid readiness=intent');
    await settle();

    const acks = controlLines().filter((e) => e.type === 'bid/accepted');
    assert.equal(acks.length, 1);
    assert.equal(acks[0].fields.participant, 'bot-a');
    assert.equal(acks[0].fields.revision, '1');
    assert.equal(acks[0].fields.r, undefined);
  } finally {
    host.stop();
  }
});
