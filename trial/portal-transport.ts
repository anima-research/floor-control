/**
 * Portal transport — the same two surfaces over the live relay:
 * room = a portal channel, control = a thread beside it. The host and each
 * scripted bot connect as their OWN enrolled personas (arbiter identity is
 * visible, §9; participantId is the relay-authenticated author, never
 * claimed). Bootstrap identities + the control thread with portal-setup.ts.
 */

import { readFileSync } from 'node:fs';
import { PortalClient } from '@animalabs/portal-client';
import type { InboundMessage, RoomTransport } from './transport.js';

export interface PortalTransportOptions {
  url: string;
  /** JSON file: { "personaId": "...", "token": "..." } */
  credsFile: string;
  roomChannelId: string;
  /** Thread under the room channel carrying ops + structured events. */
  controlThreadId: string;
}

export class PortalTransport implements RoomTransport {
  readonly locator: string;
  readonly provenance: string;
  private client: PortalClient;
  private handlers: Array<(m: InboundMessage) => void> = [];
  private selfPersonaId: string;

  constructor(private opts: PortalTransportOptions) {
    const creds = JSON.parse(readFileSync(opts.credsFile, 'utf8')) as {
      personaId: string;
      token: string;
    };
    this.selfPersonaId = creds.personaId;
    this.locator = `portal://${opts.roomChannelId}`;
    this.provenance = `portal-relay:${new URL(opts.url).host}`;
    this.client = new PortalClient({
      url: opts.url,
      token: creds.token,
      personaId: creds.personaId,
      subscriptions: [opts.roomChannelId],
    });
    this.client.on('message', ({ message: m }) => {
      const author = m.author as { kind: string; personaId?: string; userId?: string; displayName?: string; username?: string };
      const authorId = author.kind === 'persona' ? `persona:${author.personaId}` : `user:${author.userId}`;
      if (author.kind === 'persona' && author.personaId === this.selfPersonaId) return;
      const surface =
        m.threadId === this.opts.controlThreadId
          ? ('control' as const)
          : m.channelId === this.opts.roomChannelId && !m.threadId
            ? ('room' as const)
            : null;
      if (!surface) return;
      const msg: InboundMessage = {
        authorId,
        authorName: author.displayName ?? author.username ?? authorId,
        surface,
        messageId: m.nativeId,
        text: m.content,
        at: Date.parse(m.createdAt),
      };
      this.handlers.forEach((h) => h(msg));
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  onMessage(handler: (m: InboundMessage) => void): void {
    this.handlers.push(handler);
  }

  async sendRoom(text: string): Promise<string> {
    const r = await this.client.sendMessage({ channelId: this.opts.roomChannelId, content: text });
    return r.messageId;
  }

  async sendControl(text: string, mention?: string): Promise<string> {
    const mentionPersonaIds =
      mention?.startsWith('persona:') ? [mention.slice('persona:'.length)] : undefined;
    const r = await this.client.sendMessage({
      channelId: this.opts.roomChannelId,
      threadId: this.opts.controlThreadId,
      content: text,
      mentionPersonaIds,
    });
    return r.messageId;
  }

  async close(): Promise<void> {
    this.client.close?.();
  }
}
