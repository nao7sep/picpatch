import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// A computer with no build of any runtime: inspection reports it instead of throwing, and nothing installs.
vi.mock('../../src/hosts.ts', async original => ({ ...await original<typeof import('../../src/hosts.ts')>(), hostId: () => undefined, supportsRuntime: () => false }));
import { inspectEngine, inspectNativeEngine, installNativeEngine, listModels } from '../../src/index.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-unsupported-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('reports engines as unsupported, refuses to install them and marks every model unsupported', async () => {
  expect(await inspectEngine({ engineDirectory: directory })).toMatchObject({ status: 'unsupported', code: 'UNSUPPORTED_CAPABILITY' });
  expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'unsupported', code: 'UNSUPPORTED_CAPABILITY' });
  await expect(installNativeEngine({ engineDirectory: directory })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(listModels().every(model => !model.supported)).toBe(true);
});
