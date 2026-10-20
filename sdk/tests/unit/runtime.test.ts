import { expect, it } from 'vitest';
import { inspectRuntime } from '../../src/index.ts';
it('rejects invalid paths and options before starting tools', async () => {
  await expect(inspectRuntime('python')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(inspectRuntime('/unused', {}, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('does no inspection for a pre-cancelled operation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(inspectRuntime('/unused', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
});
