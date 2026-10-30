// Continuous layout edits, such as stepping a splitter with arrow keys, save a short
// delay after the last step, and each step pushes the save back. A single command
// saves at once, replacing any waiting value, and closing flushes what is waiting.

export const LAYOUT_DELAY = 500;

export class DelayedSave<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: { value: T } | undefined;
  constructor(private save: (value: T) => Promise<void>, private delay = LAYOUT_DELAY) {}
  later(value: T) {
    this.waiting = { value };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  now(value: T): Promise<void> { this.waiting = { value }; return this.flush(); }
  /** Saves the waiting value, if any; the save reports its own failure. */
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const item = this.waiting; this.waiting = undefined;
    return item ? this.save(item.value) : Promise.resolve();
  }
}
