import { expect, it, vi } from 'vitest';
const workers = vi.hoisted(() => [] as any[]);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter { postMessage = vi.fn(); terminate = vi.fn().mockResolvedValue(0); constructor() { super(); workers.push(this); } } };
});
import { RecordsReader } from '../../src/main/core/records-reader.ts';
it('bounds a stalled history read, terminates only the reader and restarts on a later explicit query', async () => {
  vi.useFakeTimers();
  const reader = new RecordsReader('/app', 'launch', '/reader');
  try {
    const query = { current: false, level: 'all' as const, search: '' };
    const first = reader.query(query); const failure = expect(first).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000); await failure;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1); expect(workers).toHaveLength(1);
    const second = reader.query(query); expect(workers).toHaveLength(2);
    const request = workers[1].postMessage.mock.calls[0][0];
    workers[0].emit('message', { id:request.id, value:{records:['stale']} });
    workers[1].emit('message', { id:request.id, value:{records:[],more:false} });
    await expect(second).resolves.toEqual({records:[],more:false});
  } finally { await reader.close(); vi.useRealTimers(); }
});
