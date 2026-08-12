/**
 * A room, to the rig, is two surfaces: the room channel (speech) and a control
 * surface (ops in, structured events out). The host and bots speak to either a
 * loopback bus (local end-to-end runs, no relay) or the portal relay
 * (portal-transport.ts) through this one interface.
 */

export interface InboundMessage {
  /** Authenticated author identity — stamped by the transport, never claimed
   *  by the participant. This is the trial's participantId. */
  authorId: string;
  authorName: string;
  surface: 'room' | 'control';
  messageId: string;
  text: string;
  at: number;
  /** Raw transport-level author fields, preserved beside the derived
   *  identity (Mica: display-name identity is a temporary compatibility
   *  key — the ledger must keep the underlying facts). */
  raw?: Record<string, unknown>;
}

export interface RoomTransport {
  /** Locator + provenance used for the room's binding claim (§5). */
  locator: string;
  provenance: string;
  onMessage(handler: (m: InboundMessage) => void): void;
  sendRoom(text: string): Promise<string>;
  /** mention: transports that can address a participant (wake) do so. */
  sendControl(text: string, mention?: string): Promise<string>;
  close(): Promise<void>;
}

// ── Loopback: an in-process bus with the same seams ──

export class LoopbackBus {
  private handlers: Array<(m: InboundMessage) => void> = [];
  private counter = 0;
  readonly log: InboundMessage[] = [];

  post(authorId: string, authorName: string, surface: 'room' | 'control', text: string): string {
    this.counter += 1;
    const m: InboundMessage = {
      authorId,
      authorName,
      surface,
      messageId: `m${this.counter}`,
      text,
      at: Date.now(),
    };
    this.log.push(m);
    // Deliver async so senders never re-enter their own handler stack.
    queueMicrotask(() => this.handlers.forEach((h) => h(m)));
    return m.messageId;
  }

  attach(handler: (m: InboundMessage) => void): void {
    this.handlers.push(handler);
  }
}

export class LoopbackTransport implements RoomTransport {
  readonly locator = 'loopback://trial/room-1';
  readonly provenance = 'loopback:local';

  constructor(
    private bus: LoopbackBus,
    private selfId: string,
    private selfName: string,
  ) {}

  onMessage(handler: (m: InboundMessage) => void): void {
    this.bus.attach((m) => {
      if (m.authorId !== this.selfId) handler(m);
    });
  }

  async sendRoom(text: string): Promise<string> {
    return this.bus.post(this.selfId, this.selfName, 'room', text);
  }

  async sendControl(text: string, _mention?: string): Promise<string> {
    return this.bus.post(this.selfId, this.selfName, 'control', text);
  }

  async close(): Promise<void> {}
}
