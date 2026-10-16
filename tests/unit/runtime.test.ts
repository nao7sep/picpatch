import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectRuntime, setupRuntime } from '../../src/index.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-runtime-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('rejects invalid paths and options before starting tools', async () => {
  await expect(inspectRuntime('python')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(inspectRuntime('/unused', { timeoutMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(setupRuntime({ directory, pythonExecutable: '/unused', uvExecutable: 'uv' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('does no setup for a pre-cancelled operation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(setupRuntime({ directory: join(directory, 'unused'), pythonExecutable: '/unused', uvExecutable: '/unused' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(inspectRuntime('/unused', { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
});
it('does not replace or clean an existing directory', async () => {
  const marker = join(directory, 'preserve'); await writeFile(marker, 'original');
  await expect(setupRuntime({ directory, pythonExecutable: '/unused', uvExecutable: '/unused' })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
  expect(await readFile(marker, 'utf8')).toBe('original');
});
it('cleans only its new directory if a setup progress callback fails', async () => {
  const path = join(directory, 'runtime');
  await expect(setupRuntime({ directory: path, pythonExecutable: '/unused', uvExecutable: '/unused' }, { onProgress: () => { throw new Error('callback'); } })).rejects.toMatchObject({ code: 'CALLBACK_FAILED' });
  await expect(readFile(join(path, 'project', 'uv.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});
