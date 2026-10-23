// Draft persistence: typing waits briefly, structural edits save at once, and every
// write lands in submission order with the draft as it was when it was requested.
import type { Draft } from '../../shared/session.ts';

export const DRAFT_DELAY = 350;

export class DraftWriter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: { id: string; draft: Draft; generation: number } | undefined;
  private generations = new Map<string, number>();

  private accept(id: string, draft: Draft) {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    return { id, draft, generation };
  }
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private save: (id: string, draft: Draft) => Promise<unknown>, private report: (error: unknown | undefined) => void) {}

  later(id: string, draft: Draft) {
    if (this.waiting && this.waiting.id !== id) void this.flush().catch(() => {});
    this.waiting = this.accept(id, draft);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, DRAFT_DELAY);
  }

  now(id: string, draft: Draft): Promise<void> {
    this.waiting = this.accept(id, draft);
    return this.flush();
  }

  /** Writes any waiting draft and settles every earlier write; rejects when the last write failed. */
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const item = this.waiting; this.waiting = undefined;
    if (!item) return this.chain.then(() => undefined);
    const snapshot = structuredClone(item.draft);
    const next = this.chain.catch(() => {}).then(() => this.save(item.id, snapshot));
    this.chain = next;
    return next.then(() => { this.report(undefined); }, error => {
      // A failed write stays waiting, unless a newer draft replaced it, so the next flush retries it.
      if (this.generations.get(item.id) === item.generation && !this.waiting) this.waiting = item;
      this.report(error); throw error;
    });
  }

  dispose() { clearTimeout(this.timer); }
}
