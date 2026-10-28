import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { expect, it } from 'vitest';
import { liveCache } from '../helpers/live-cache.ts';

it('runs real FLUX.2 generation and ordered references on CPU and Metal with tiny weights', async () => {
  const python = process.env.PICPATCH_DIFFUSERS_PYTHON ?? liveCache('diffusers-audit/venv/bin/python');
  const source = ['common', 'diffusers'].map(name => fileURLToPath(new URL(`../../runtimes/${name}/src`, import.meta.url))).join(delimiter);
  const result = await promisify(execFile)(python, [fileURLToPath(new URL('./flux2_runtime_probe.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: source, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  expect(result.stdout).toContain('seeded sampling and cancellation passed');
});
