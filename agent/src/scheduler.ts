/**
 * Per-conversation debounce + serialisation.
 *
 * Leads send bursts ("hi" … "I have a boutique" … "how much?"). Each
 * message restarts a short quiet timer, so the agent answers the whole
 * burst once — like a person who waits for you to finish typing. A
 * burst can't postpone the reply forever: `maxWaitMs` after its first
 * message, the turn runs anyway.
 *
 * A conversation never has two turns running at once. A message that
 * arrives mid-turn schedules exactly one follow-up turn after it.
 */
export interface SchedulerOptions {
  debounceMs: number;
  maxWaitMs: number;
  runTurn: (conversationId: string) => Promise<void>;
  onError?: (conversationId: string, err: unknown) => void;
}

interface Slot {
  timer: ReturnType<typeof setTimeout> | null;
  firstAt: number;
  running: boolean;
  rerun: boolean;
}

export class ConversationScheduler {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly opts: SchedulerOptions) {}

  /** A new customer message arrived in this conversation. */
  notify(conversationId: string): void {
    const now = Date.now();
    let slot = this.slots.get(conversationId);
    if (!slot) {
      slot = { timer: null, firstAt: now, running: false, rerun: false };
      this.slots.set(conversationId, slot);
    }
    if (slot.running) {
      slot.rerun = true;
      return;
    }
    if (slot.timer) clearTimeout(slot.timer);
    else slot.firstAt = now;
    const remainingMax = slot.firstAt + this.opts.maxWaitMs - now;
    const delay = Math.max(0, Math.min(this.opts.debounceMs, remainingMax));
    slot.timer = setTimeout(() => void this.fire(conversationId), delay);
  }

  /** Conversations with a pending or running turn (for /health). */
  get pending(): number {
    return this.slots.size;
  }

  private async fire(conversationId: string): Promise<void> {
    const slot = this.slots.get(conversationId);
    if (!slot) return;
    slot.timer = null;
    slot.running = true;
    try {
      await this.opts.runTurn(conversationId);
    } catch (err) {
      this.opts.onError?.(conversationId, err);
    } finally {
      slot.running = false;
      if (slot.rerun) {
        slot.rerun = false;
        slot.firstAt = Date.now();
        slot.timer = setTimeout(() => void this.fire(conversationId), this.opts.debounceMs);
      } else {
        this.slots.delete(conversationId);
      }
    }
  }
}
