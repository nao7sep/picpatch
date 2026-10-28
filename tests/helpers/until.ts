/**
 * Waits, with no bound, until a check passes: it runs at once, then again after each turn of the event loop, so a
 * state that already holds is seen without waiting. A check passes when it neither throws nor rejects.
 */
export async function until(check: () => unknown): Promise<void> {
  for (;;) {
    try { await check(); return; } catch { /* Not yet. */ }
    await new Promise(resolve => setImmediate(resolve));
  }
}
