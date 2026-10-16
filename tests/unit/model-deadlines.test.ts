import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverModels, inspectModel } from '../../src/models/inspection.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath), lstat: vi.fn(actual.lstat) };
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it.each([inspectModel, (path: string, options: Parameters<typeof inspectModel>[1]) => discoverModels([path], options)])('waits for active filesystem work before reporting a deadline', async operation => {
  vi.useFakeTimers();
  let release!: (path: string) => void;
  const read = vi.spyOn(fs, 'realpath').mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
  const nextRead = vi.spyOn(fs, 'lstat');
  let settled = false;
  const result = operation('/selected', { timeoutMs: 10 }).finally(() => { settled = true; });
  const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(10);
  expect(read).toHaveBeenCalledOnce(); expect(settled).toBe(false);
  release('/selected');
  await assertion;
  expect(nextRead).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('reports caller cancellation when cancellation and deadline both occur during a read', async () => {
  vi.useFakeTimers();
  let release!: (path: string) => void;
  vi.spyOn(fs, 'realpath').mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const result = inspectModel('/selected', { timeoutMs: 10, signal: controller.signal });
  const assertion = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
  controller.abort(); await vi.advanceTimersByTimeAsync(10); release('/selected');
  await assertion;
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid budgets before filesystem access: %s', async timeoutMs => {
  const read = vi.spyOn(fs, 'realpath');
  await expect(inspectModel('/selected', { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(discoverModels(['/selected'], { timeoutMs })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(read).not.toHaveBeenCalled();
});
