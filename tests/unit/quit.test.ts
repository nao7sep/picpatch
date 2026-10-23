import { afterEach, expect, it, vi } from 'vitest';
import { quitFlow } from '../../src/main/quit.ts';
import { Settlement, observe } from '../../src/main/core/settlement.ts';
import { rendererRequests } from '../../src/main/renderer-requests.ts';
function fixture() {
  const port = {
    freeze: vi.fn(), flush: vi.fn(async () => {}), drafts: vi.fn(async () => true),
    saveFailure: vi.fn(async (_error: unknown): Promise<number | undefined> => undefined),
    work: vi.fn(async () => true), settle: vi.fn(async () => {}), finish: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    interrupt: vi.fn(), shutdownSave: vi.fn(async () => {}), exit: vi.fn(), forceExit: vi.fn(),
  };
  return { port, flow: quitFlow(port) };
}
afterEach(() => vi.useRealTimers());
it('joins repeated close requests and cancels without discarding a dirty draft', async () => {
  const { port, flow } = fixture();
  let answer!: (value: boolean) => void;
  port.drafts.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const first = flow.close(); expect(flow.close()).toBe(first);
  await vi.waitFor(() => expect(port.drafts).toHaveBeenCalledOnce()); answer(false); await first;
  expect(port.finish).not.toHaveBeenCalled(); expect(port.freeze.mock.calls).toEqual([[true], [false]]);
});
it('offers retry after a failed save and checks work before draft approval', async () => {
  const { port, flow } = fixture();
  port.flush.mockRejectedValueOnce(new Error('save failed')); port.saveFailure.mockResolvedValue(1);
  await flow.close(); expect(port.flush).toHaveBeenCalledTimes(2); expect(port.finish).toHaveBeenCalledOnce();
  expect(port.work.mock.invocationCallOrder[0]).toBeLessThan(port.drafts.mock.invocationCallOrder[0]!);
});
it('keeps the app open when a decision cannot be shown', async () => {
  const { port, flow } = fixture();
  port.flush.mockRejectedValue(new Error('save failed')); port.saveFailure.mockRejectedValue(new Error('renderer gone'));
  await flow.close(); expect(port.finish).not.toHaveBeenCalled(); expect(port.failed).toHaveBeenCalledOnce();
});
it('quit anyway still asks about drafts; cancelling work does not ask about discarding them', async () => {
  const { port, flow } = fixture();
  port.flush.mockRejectedValue(new Error('save failed')); port.saveFailure.mockResolvedValue(2);
  port.work.mockResolvedValueOnce(false);
  await flow.close(); expect(port.drafts).not.toHaveBeenCalled();
  await flow.close(); expect(port.drafts).toHaveBeenCalledOnce(); expect(port.finish).toHaveBeenCalledOnce();
});
it('OS takeover interrupts a human question and exits once at the total deadline', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  let answer!: (value: boolean) => void;
  port.drafts.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  let saved!: () => void;
  port.shutdownSave.mockImplementation(() => new Promise(resolve => { saved = resolve; }));
  const attempt = flow.close(); await vi.advanceTimersByTimeAsync(0);
  flow.shutdown(); flow.shutdown(); expect(port.interrupt).toHaveBeenCalledOnce();
  answer(false); await attempt; expect(port.finish).not.toHaveBeenCalled();
  // A save still pending at the deadline may be stuck in native I/O, so the end is forced rather than a cleanup exit.
  await vi.advanceTimersByTimeAsync(1000); expect(port.forceExit).toHaveBeenCalledOnce(); expect(port.exit).not.toHaveBeenCalled();
  saved(); await vi.advanceTimersByTimeAsync(0); expect(port.forceExit).toHaveBeenCalledOnce(); expect(port.exit).not.toHaveBeenCalled();
  expect(port.freeze).toHaveBeenCalledExactlyOnceWith(true);
});
it('OS takeover exits normally when the save settles within the deadline', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  flow.shutdown(); await vi.advanceTimersByTimeAsync(0);
  expect(port.exit).toHaveBeenCalledOnce(); expect(port.forceExit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(port.forceExit).not.toHaveBeenCalled();
});
it('late flush replies cannot satisfy a later request, and interrupted questions reject', async () => {
  vi.useFakeTimers(); const send = vi.fn(); const requests = rendererRequests(send);
  const first = requests.request({ kind: 'flush' }, 50); const rejected = expect(first).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(50); await rejected;
  const second = requests.request({ kind: 'flush' }, 50); const settled = vi.fn(); void second.then(settled);
  requests.reply({ id: 1, ok: true }); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
  requests.reply({ id: 2, ok: true }); await second;
  const question = requests.request({ kind: 'closeDrafts' }); const interrupted = expect(question).rejects.toThrow();
  requests.cancelAll(); await interrupted;
});

it.each([0, 1, 2])('offers decision %s after accepted-save failure, following work and draft approval', async answer => {
  const { port, flow } = fixture(); const failure = new Error('Required save failed');
  port.settle.mockRejectedValueOnce(failure);
  port.saveFailure.mockResolvedValue(answer);
  await flow.close();
  expect(port.saveFailure).toHaveBeenCalledExactlyOnceWith(failure);
  expect(port.work.mock.invocationCallOrder[0]).toBeLessThan(port.drafts.mock.invocationCallOrder[0]!);
  expect(port.drafts.mock.invocationCallOrder[0]).toBeLessThan(port.settle.mock.invocationCallOrder[0]!);
  if (answer === 0) expect(port.finish).not.toHaveBeenCalled();
  else expect(port.finish).toHaveBeenCalledExactlyOnceWith(answer === 2);
  expect(port.settle).toHaveBeenCalledTimes(answer === 1 ? 2 : 1);
  expect(port.failed).not.toHaveBeenCalled();
});
it('Retry observes the same held effect after a save timeout without submitting it twice', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  const owner = new Settlement(); const held = Promise.withResolvers<void>(); const effect = vi.fn(() => held.promise);
  const accepted = owner.track(effect);
  port.settle.mockImplementation(() => observe(owner.settled(), 20));
  port.saveFailure.mockImplementation(async () => { held.resolve(); return 1; });
  const closing = flow.close();
  await vi.advanceTimersByTimeAsync(20); await closing; await accepted;
  expect(port.saveFailure).toHaveBeenCalledOnce(); expect(port.settle).toHaveBeenCalledTimes(2);
  expect(effect).toHaveBeenCalledOnce(); expect(port.finish).toHaveBeenCalledExactlyOnceWith(false);
});
it.each([0, 2])('timeout decision %s leaves the held effect owned through its late publication', async answer => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  const owner = new Settlement(); const held = Promise.withResolvers<void>(); const published = vi.fn();
  const accepted = owner.track(async () => { await held.promise; published(); });
  port.settle.mockImplementation(() => observe(owner.settled(), 20)); port.saveFailure.mockResolvedValue(answer);
  const closing = flow.close(); await vi.advanceTimersByTimeAsync(20); await closing;
  if (answer === 0) expect(port.finish).not.toHaveBeenCalled();
  else expect(port.finish).toHaveBeenCalledExactlyOnceWith(true);
  const done = vi.fn(); const remaining = owner.settled().then(done);
  await vi.advanceTimersByTimeAsync(100); expect(done).not.toHaveBeenCalled(); expect(published).not.toHaveBeenCalled();
  held.resolve(); await accepted; await remaining; expect(published).toHaveBeenCalledOnce();
});
it('OS takeover bounds a held accepted-save wait with one total deadline and ignores late completion', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture(); const held = Promise.withResolvers<void>();
  port.settle.mockImplementation(() => held.promise); port.shutdownSave.mockImplementation(() => held.promise);
  const closing = flow.close(); await vi.advanceTimersByTimeAsync(0); expect(port.settle).toHaveBeenCalledOnce();
  flow.shutdown(); flow.shutdown(); await vi.advanceTimersByTimeAsync(999);
  expect(port.forceExit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(port.forceExit).toHaveBeenCalledOnce(); expect(port.exit).not.toHaveBeenCalled();
  held.resolve(); await closing; await vi.advanceTimersByTimeAsync(0);
  expect(port.finish).not.toHaveBeenCalled(); expect(port.saveFailure).not.toHaveBeenCalled();
  expect(port.forceExit).toHaveBeenCalledOnce(); expect(port.exit).not.toHaveBeenCalled();
});
