import { afterEach, expect, it, vi } from 'vitest';
import { quitFlow } from '../../src/main/quit.ts';
import { rendererRequests } from '../../src/main/renderer-requests.ts';
function fixture() {
  const port = {
    freeze: vi.fn(), flush: vi.fn(async () => {}), drafts: vi.fn(async () => true),
    saveFailure: vi.fn(async (_error: unknown): Promise<number | undefined> => undefined),
    work: vi.fn(async () => true), finish: vi.fn(async () => {}), failed: vi.fn(async () => {}),
    interrupt: vi.fn(), shutdownSave: vi.fn(async () => {}), quit: vi.fn(), exit: vi.fn(), forceExit: vi.fn(),
  };
  return { port, flow: quitFlow(port) };
}
afterEach(() => vi.useRealTimers());
it('joins repeated close requests and cancels without discarding a dirty draft', async () => {
  const { port, flow } = fixture();
  const asked = Promise.withResolvers<(value: boolean) => void>();
  port.drafts.mockImplementation(() => new Promise(resolve => asked.resolve(resolve)));
  const first = flow.close(); expect(flow.close()).toBe(first);
  (await asked.promise)(false); await first;
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
it('OS takeover exits normally when the save settles within the deadline, and forces an exit still running at it', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  flow.shutdown(); await vi.advanceTimersByTimeAsync(0);
  expect(port.exit).toHaveBeenCalledOnce(); expect(port.forceExit).not.toHaveBeenCalled();
  // A real exit has ended the process by now; one Electron is still waiting in is ended at the deadline.
  await vi.advanceTimersByTimeAsync(1000); expect(port.forceExit).toHaveBeenCalledOnce(); expect(port.exit).toHaveBeenCalledOnce();
});
it('an ordinary close draws every step on one deadline that restarts after each answer', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  let answer!: (value: number) => void;
  port.flush.mockRejectedValueOnce(new Error('save failed'));
  port.saveFailure.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  port.finish.mockImplementation(() => new Promise(() => {}));
  const attempt = flow.close(); await vi.advanceTimersByTimeAsync(0);
  expect(port.flush).toHaveBeenLastCalledWith(5000);
  // The question pauses the deadline: answering long after it would have passed starts it again.
  await vi.advanceTimersByTimeAsync(60_000); answer(1); await vi.advanceTimersByTimeAsync(0);
  expect(port.flush).toHaveBeenLastCalledWith(5000); expect(port.finish).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4999); expect(port.forceExit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(port.forceExit).toHaveBeenCalledOnce(); expect(port.quit).not.toHaveBeenCalled();
  void attempt;
});
it('an ordinary close quits once its steps finish, with the deadline still backing the exit', async () => {
  vi.useFakeTimers(); const { port, flow } = fixture();
  await flow.close(); expect(port.quit).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4999); expect(port.forceExit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(port.forceExit).toHaveBeenCalledOnce();
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
