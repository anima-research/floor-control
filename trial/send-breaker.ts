/**
 * Send-rate circuit breaker — blast-radius control for channels people
 * live in (shadow-mode prerequisite; the cc-spawner burst and the F14
 * churn are the two measured failure shapes).
 *
 * The budget belongs to the ROOM, not to any one sender: a rig with an
 * arbiter and N bots must count every outbound send against one shared
 * window, or the automated senders bypass the stated cap (Mica review,
 * 2026-08-28, seam 1). Construct one SendBreaker per room and hand the
 * same instance to every transport bound to it; rig-wiring.ts is the
 * production path that does this.
 *
 * Contract when the rolling window fills:
 *   - one final plain notice is sent to the room, then hard silence
 *     until the window drains;
 *   - the notice's settlement is OWNED here: sending does not resume
 *     after a drain until the notice has definitively landed or been
 *     abandoned, so a retrying notice can never arrive after ordinary
 *     sending has resumed (seam 3 — the probe order was
 *     one → notice-fail → after-reset → notice-success);
 *   - every suppressed send is counted, never individually ledgered —
 *     a runaway must not flood the ledger through its own containment;
 *     the trip/reset receipt pair carries the counts;
 *   - shutdown while tripped emits one bounded terminal state receipt
 *     (no room send), so the suppressed count survives the process
 *     (seam 2).
 */

export interface SendBudget {
  /** Max sends inside any rolling window. */
  maxSends: number;
  windowMs: number;
}

export type SendVerdict = 'admitted' | 'suppressed' | 'tripped';

export class SendBreaker {
  /** Timestamps of admitted sends inside the rolling window — across
   *  every transport sharing this breaker. */
  private sendTimes: number[] = [];
  /** Non-null while tripped: suppressed-send counter for the receipts. */
  private tripped: { at: number; suppressed: number } | null = null;
  /** The final notice's settlement. Sending must not resume until
   *  `settled` — landed or truthfully abandoned. */
  private notice: { settled: boolean; settlement: Promise<void> } | null = null;
  private finalReceiptEmitted = false;

  constructor(
    private budget: SendBudget,
    private onAnomaly?: (entry: Record<string, unknown>) => void,
  ) {}

  /**
   * Gate one outbound send. `sendNotice` is the calling transport's
   * UNGUARDED send path to the room channel — the breaker uses it for
   * the final notice on trip (which must not re-enter the breaker) and
   * takes ownership of its settlement. A caller that receives
   * 'tripped' should await noticeSettlement() before returning, so the
   * trip call itself does not resolve with the notice still in flight.
   */
  admit(now: number, persona: string, sendNotice: (text: string) => Promise<string>): SendVerdict {
    const { maxSends, windowMs } = this.budget;
    this.sendTimes = this.sendTimes.filter((t) => now - t < windowMs);
    if (this.tripped) {
      const drained = this.sendTimes.length < maxSends;
      if (drained && (this.notice === null || this.notice.settled)) {
        // Window drained AND the notice is settled: resume, and say
        // truthfully what was dropped. Resuming before settlement would
        // let a retrying notice land after ordinary speech restarts.
        this.onAnomaly?.({
          kind: 'send-breaker-reset',
          at: now,
          persona,
          trippedAt: this.tripped.at,
          suppressed: this.tripped.suppressed,
        });
        this.tripped = null;
        this.notice = null;
        this.sendTimes.push(now);
        return 'admitted';
      }
      this.tripped.suppressed += 1;
      return 'suppressed';
    }
    if (this.sendTimes.length >= maxSends) {
      this.tripped = { at: now, suppressed: 1 };
      this.onAnomaly?.({
        kind: 'send-breaker-trip',
        at: now,
        persona,
        maxSends,
        windowMs,
      });
      // One final plain notice — the room deserves to know the sender
      // went quiet and why; after this line, hard silence until the
      // window drains AND this settlement resolves.
      const notice = { settled: false, settlement: Promise.resolve() };
      notice.settlement = sendNotice(
        `[floor service: send budget exhausted (${maxSends}/${Math.round(windowMs / 1000)}s) — going quiet until the window drains; sends in between are being dropped and counted]`,
      )
        .then((id) => {
          // The transport's send path returns '' for a definitive drop;
          // record the abandonment so "one final notice, then silence"
          // stays truthful when the notice itself never landed.
          if (id === '') {
            this.onAnomaly?.({ kind: 'send-breaker-notice-abandoned', at: Date.now(), persona });
          }
        })
        .catch(() => {
          this.onAnomaly?.({ kind: 'send-breaker-notice-abandoned', at: Date.now(), persona });
        })
        .finally(() => {
          notice.settled = true;
        });
      this.notice = notice;
      return 'tripped';
    }
    this.sendTimes.push(now);
    return 'admitted';
  }

  /** Resolves when the current final notice has landed or been
   *  abandoned; resolved immediately when no notice is in flight. */
  noticeSettlement(): Promise<void> {
    return this.notice?.settlement ?? Promise.resolve();
  }

  /**
   * Shutdown receipt: if the breaker is tripped when the process goes
   * down, the suppressed count must not vanish with it. One bounded
   * ledger entry, never a room send; idempotent so every transport
   * sharing the breaker (and the rig's own shutdown path) can call it.
   */
  emitFinalReceipt(now: number): void {
    if (this.finalReceiptEmitted || !this.tripped) return;
    this.finalReceiptEmitted = true;
    this.onAnomaly?.({
      kind: 'send-breaker-final',
      at: now,
      trippedAt: this.tripped.at,
      suppressed: this.tripped.suppressed,
      noticeSettled: this.notice?.settled ?? true,
    });
  }
}
