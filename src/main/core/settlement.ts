/** Accepted effects stay owned when a caller's bounded observation ends. */
export class Settlement {
  private pending = new Set<Promise<unknown>>();
  track<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(work);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
/** A timeout ends observation, never the underlying operation or its ownership. */
export async function observe<T>(task: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Accepted saves have not settled.')), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}
