/**
 * Portal transport — the two surfaces over the live relay.
 *
 * Two relay realities discovered empirically (probe, 2026-08-11) shape this
 * implementation; both differ from the published protocol docs:
 *
 * 1. Persona sends echo back as webhook USERS (`kind:"user"`, `bot:true`,
 *    stable webhook userId, username = persona display name) — never as
 *    `kind:"persona"`. Self-filtering therefore matches on our own sent
 *    relay-message ids (primary) and the webhook-echo name shape (fallback).
 * 2. `threadId` is ABSENT on delivered messages even when they live in a
 *    thread, so surfaces cannot be told apart by thread. Bands are
 *    classified by SYNTAX instead: `!floor …` and `⟨floor⟩ …` lines are
 *    control traffic wherever they appear; everything else is room speech.
 *    Control is still SENT to the thread for human readability.
 *
 * Sends are hardened: one retry, then log-and-drop — a single RPC timeout
 * must never become an unhandled rejection that kills the arbiter (that is
 * exactly how the first live run died).
 */

import { readFileSync } from 'node:fs';
import { PortalClient } from '@animalabs/portal-client';
import type { InboundMessage, RoomTransport } from './transport.js';

export interface PortalTransportOptions {
  url: string;
  /** JSON file: { "personaId": "...", "token": "..." } */
  credsFile: string;
  /** Persona display name — used for webhook-echo self-filtering. */
  personaName: string;
  roomChannelId: string;
  /** Thread for outgoing control traffic (readability); inbound
   *  classification is syntactic, not thread-based. */
  controlThreadId?: string;
}

const CONTROL_PREFIXES = ['!floor', '⟨floor⟩'];

export class PortalTransport implements RoomTransport {
  readonly locator: string;
  readonly provenance: string;
  private client: PortalClient;
  private handlers: Array<(m: InboundMessage) => void> = [];
  private sentIds = new Set<string>();

  constructor(private opts: PortalTransportOptions) {
    const creds = JSON.parse(readFileSync(opts.credsFile, 'utf8')) as {
      personaId: string;
      token: string;
    };
    this.locator = `portal://${opts.roomChannelId}`;
    this.provenance = `portal-relay:${new URL(opts.url).host}`;
    this.client = new PortalClient({
      url: opts.url,
      token: creds.token,
      personaId: creds.personaId,
      subscriptions: [opts.roomChannelId],
    });
    this.client.on('message', ({ message: m }) => {
      if (m.channelId !== this.opts.roomChannelId) return;
      if (this.sentIds.has(m.id)) return; // own send, echoed back
      const author = m.author as {
        kind: string;
        personaId?: string;
        userId?: string;
        displayName?: string;
        username?: string;
        bot?: boolean;
      };
      // Webhook-echo fallback: our own name coming back as a bot user. Covers
      // the race where the echo lands before sendMessage resolves with its id.
      if (author.bot === true && (author.username === this.opts.personaName || author.displayName === this.opts.personaName)) {
        return;
      }
      const authorId = author.kind === 'persona' ? `persona:${author.personaId}` : `user:${author.userId}`;
      const text = m.content ?? '';
      const surface = CONTROL_PREFIXES.some((p) => text.startsWith(p)) ? ('control' as const) : ('room' as const);
      const msg: InboundMessage = {
        authorId,
        authorName: author.displayName ?? author.username ?? authorId,
        surface,
        messageId: m.nativeId,
        text,
        at: Date.parse(m.createdAt),
      };
      this.handlers.forEach((h) => {
        try {
          h(msg);
        } catch (err) {
          console.error(`[portal-transport ${this.opts.personaName}] handler error:`, err);
        }
      });
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  onMessage(handler: (m: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async sendRoom(text: string): Promise<string> {
    return this.safeSend({ channelId: this.opts.roomChannelId, content: text });
  }

  async sendControl(text: string, mention?: string): Promise<string> {
    const mentionPersonaIds =
      mention?.startsWith('persona:') ? [mention.slice('persona:'.length)] : undefined;
    return this.safeSend({
      channelId: this.opts.roomChannelId,
      ...(this.opts.controlThreadId ? { threadId: this.opts.controlThreadId } : {}),
      content: text,
      mentionPersonaIds,
    });
  }

  /** One retry, then log-and-drop. Never throws into a fire-and-forget. */
  private async safeSend(params: Parameters<PortalClient['sendMessage']>[0]): Promise<string> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.client.sendMessage(params);
        this.remember(r.messageId);
        return r.messageId;
      } catch (err) {
        if (attempt === 2) {
          console.error(`[portal-transport ${this.opts.personaName}] send failed twice, dropping:`, (err as Error).message);
          return '';
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return '';
  }

  private remember(id: string): void {
    this.sentIds.add(id);
    if (this.sentIds.size > 500) {
      const oldest = this.sentIds.values().next().value;
      if (oldest) this.sentIds.delete(oldest);
    }
  }

  async close(): Promise<void> {
    this.client.close?.();
  }
}
