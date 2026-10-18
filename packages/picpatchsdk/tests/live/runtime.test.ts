import { testPython } from '../helpers/python.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inspectRuntime } from '../../src/index.ts';
it('inspects the real environment and reports truthful model-free readiness', async () => {
  expect(await inspectRuntime(testPython)).toMatchObject({ status: 'worker-ready', models: [] });
});

it('reports an absent interpreter through the public runtime check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-runtime-'));
  try {
    await expect(inspectRuntime(join(directory, 'absent-python'))).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
