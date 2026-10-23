import { afterEach, expect, it, vi } from 'vitest';
import { Settlement, observe } from '../../src/main/core/settlement.ts';

afterEach(() => vi.useRealTimers());
it('keeps an accepted effect owned after observation times out until its actual completion', async () => {
  vi.useFakeTimers();
  const owner = new Settlement(); const held = Promise.withResolvers<string>();
  const effect = vi.fn(() => held.promise); const task = owner.track(effect);
  const first = expect(observe(task, 20)).rejects.toThrow('not settled');
  await vi.advanceTimersByTimeAsync(20); await first;
  const done = vi.fn(); const settlement = owner.settled().then(done);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).not.toHaveBeenCalled(); expect(effect).toHaveBeenCalledOnce();
  const retry = observe(task, 20);
  held.resolve('published');
  await expect(retry).resolves.toBe('published'); await settlement;
  expect(done).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce();
});
it('observes all accepted effects, including another admitted while settlement waits', async () => {
  const owner = new Settlement(); const first = Promise.withResolvers<void>(); const second = Promise.withResolvers<void>();
  const a = owner.track(() => first.promise); const done = vi.fn(); const settlement = owner.settled().then(done);
  const b = owner.track(() => second.promise);
  first.resolve(); await a; await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  second.resolve(); await b; await settlement; expect(done).toHaveBeenCalledOnce();
});
it('returns an effect’s failure to its caller and releases its settled ownership', async () => {
  const owner = new Settlement(); const cause = new Error('Save failed');
  const task = owner.track(async () => { throw cause; });
  await expect(task).rejects.toBe(cause);
  await expect(owner.settled()).resolves.toBeUndefined();
});
