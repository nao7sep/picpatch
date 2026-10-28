import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { expect, it } from 'vitest';
import { liveCache } from '../helpers/live-cache.ts';

it('runs stock GLM denoising and two-reference caching with tiny random weights on CPU and Metal', async () => {
  const python = process.env.PICPATCH_DIFFUSERS_PYTHON ?? liveCache('diffusers-audit/venv/bin/python');
  const source = ['common', 'diffusers'].map(name => fileURLToPath(new URL(`../../runtimes/${name}/src`, import.meta.url))).join(delimiter);
  const result = await promisify(execFile)(python, [fileURLToPath(new URL('./glm_runtime_probe.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: source, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  expect(result.stdout).toContain('GLM CPU/Metal generation, two-reference cache and cancellation passed');
});
