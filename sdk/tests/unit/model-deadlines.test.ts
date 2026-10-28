import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverModels, inspectModel } from '../../src/models/inspection.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

afterEach(() => { vi.restoreAllMocks(); });
it('awaits a pending local read to its end and then reports caller cancellation', async () => {
  let release!: (path: string) => void;
  const entered = Promise.withResolvers<void>();
  vi.spyOn(fs, 'realpath').mockImplementation(() => { entered.resolve(); return new Promise<string>(resolve => { release = resolve; }); });
  const controller = new AbortController();
  const result = inspectModel('/selected', { signal: controller.signal });
  await entered.promise;
  controller.abort(); release('/selected');
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid budgets before filesystem access: %s', async timeoutMs => {
  const read = vi.spyOn(fs, 'realpath');
  await expect(inspectModel('/selected', { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(discoverModels(['/selected'], { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(read).not.toHaveBeenCalled();
});
