/**
 * Rig wiring — the one place transport options for a live room are
 * assembled. Extracted from run-portal.ts so the wiring itself is
 * testable: the property that matters (Mica review 2026-08-28, seam 1)
 * is that EVERY outbound transport — arbiter and bots alike — shares
 * one SendBreaker, so the room budget caps aggregate output rather
 * than one persona's. A budget wired to the arbiter alone is a cap the
 * automated senders walk around.
 */

import type { PortalTransportOptions } from './portal-transport.js';
import { SendBreaker, type SendBudget } from './send-breaker.js';

export interface RigSpec {
  url: string;
  roomChannelId: string;
  controlThreadId?: string;
}

export interface RigWiring {
  host: PortalTransportOptions;
  bots: PortalTransportOptions[];
  /** The room's shared breaker (undefined when no budget was asked
   *  for). The rig's shutdown path finalizes it — see
   *  SendBreaker.emitFinalReceipt. */
  breaker?: SendBreaker;
}

export function wireTransportOptions(
  rig: RigSpec,
  opts: {
    botNames: string[];
    onAnomaly: (entry: Record<string, unknown>) => void;
    sendBudget?: SendBudget;
    credsDir?: string;
  },
): RigWiring {
  const credsDir = opts.credsDir ?? 'trial/creds';
  // One breaker for the room; every options object below references it.
  const breaker = opts.sendBudget ? new SendBreaker(opts.sendBudget, opts.onAnomaly) : undefined;
  const common = {
    url: rig.url,
    roomChannelId: rig.roomChannelId,
    controlThreadId: rig.controlThreadId,
    onAnomaly: opts.onAnomaly,
    ...(breaker ? { sendBudget: breaker } : {}),
  };
  return {
    host: {
      ...common,
      credsFile: `${credsDir}/floor-service.creds.json`,
      personaName: 'floor-service',
    },
    bots: opts.botNames.map((name) => ({
      ...common,
      credsFile: `${credsDir}/${name}.creds.json`,
      personaName: name,
    })),
    breaker,
  };
}
