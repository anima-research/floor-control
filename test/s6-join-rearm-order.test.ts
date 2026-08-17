/**
 * S6 deterministic discriminator — the late-join idle re-arm race
 * (Mica re-review 2026-08-17: loopback S6 failed 2/12 with woke=false,
 * joinRearms=0, no fresh emission).
 *
 * Diagnosis: a real host ordering bug, not a flaky receipt. The re-arm
 * condition compared the join's MESSAGE STAMP (`m.at`, taken at post time)
 * against the tick clock's `lastIdleAt`. When a genuine first join is
 * processed after an idle emission but its stamp ties with the emission's
 * millisecond — or precedes it outright under redelivery — the strict
 * `lastActivityAt > lastIdleAt` comparison is false, the join is silently
 * not a liveness transition, and the room never re-arms: exactly the
 * observed signature. The 2/12 rate was the same-millisecond tie; this
 * test removes the coin-flip by stamping the join in the past, which the
 * pre-fix host swallows on every run.
 *
 * The invariant under test (FINDING-7, Mica ruling 2026-08-13): a genuine
 * join is a liveness transition in PROCESSING ORDER. Stamps are receipts
 * of when a thing was said, not of when the host learned it.
 *
 * Unlike the rest of this directory these tests run the real ticking host
 * (the bug lives in the host's clock handling, so an explicit-clock walk
 * can't witness it); timings stay compact and every wait polls a public
 * counter rather than sleeping a fixed amount.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FloorRoomHost } from '../trial/host.js';
import { LoopbackBus, LoopbackTransport } from '../trial/transport.js';
import { FluidFairnessLogic } from '../src/logics.js';

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
  const host = new FloorRoomHost(
    new LoopbackTransport(bus, 'floor-service', 'floor-service'),
    new FluidFairnessLogic({ speechLeaseMs: 1000 }),
    { tickMs: 25, idleAfterMs: 150, exemptIds: ['ra-human'] },
  );
  return { bus, host };
}

test('a first join stamped at-or-before the last idle emission still re-arms (processing order wins)', async () => {
  const { bus, host } = rig();
  host.start();
  try {
    bus.post('ra-human', 'ra-human', 'room', 'seed: anyone here?');
    assert.ok(await until(() => host.idleEmissions >= 1, 5_000), 'first idle emission');
    const emissionsAtJoin = host.idleEmissions;

    // The discriminator: a genuine first join whose stamp is decisively in
    // the past — the deterministic form of the same-millisecond tie the
    // suite hit 2/12. Processing order says this join happened AFTER the
    // emission; the stamp says before. The newcomer's claim to a fresh
    // floor/idle rides on processing order.
    bus.post('late-bot', 'late-bot', 'control', '!floor join', 0);

    const rearmed = await until(
      () => host.idleRearms.some((r) => r.cause === 'participant/joined'),
      2_000,
    );
    assert.ok(rearmed, 'stale-stamped first join must re-arm the one-shot idle');

    assert.ok(
      await until(() => host.idleEmissions >= emissionsAtJoin + 1, 5_000),
      'a fresh floor/idle must reach the newcomer',
    );
  } finally {
    host.stop();
  }
});

test('a duplicate stale-stamped join is idempotent — one liveness transition, one re-arm', async () => {
  const { bus, host } = rig();
  host.start();
  try {
    bus.post('ra-human', 'ra-human', 'room', 'seed: anyone here?');
    assert.ok(await until(() => host.idleEmissions >= 1, 5_000), 'first idle emission');

    bus.post('late-bot', 'late-bot', 'control', '!floor join', 0);
    bus.post('late-bot', 'late-bot', 'control', '!floor join', 0); // relay redelivery

    assert.ok(
      await until(() => host.idleRearms.some((r) => r.cause === 'participant/joined'), 2_000),
      'first join re-arms',
    );
    // Let any wrongly-counted second transition surface before asserting.
    await until(() => host.idleRearms.filter((r) => r.cause === 'participant/joined').length > 1, 300);
    assert.equal(
      host.idleRearms.filter((r) => r.cause === 'participant/joined').length,
      1,
      'duplicate join processing is not a second liveness transition',
    );
  } finally {
    host.stop();
  }
});
