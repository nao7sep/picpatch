import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { expect, it } from 'vitest';
import { liveCache } from '../helpers/live-cache.ts';

it('runs the actual DreamO pipeline with tiny random weights on CPU and Metal', async () => {
  const python = process.env.PICPATCH_DREAMO_PYTHON ?? liveCache('dreamo-audit/venv/bin/python');
  const source = ['common', 'dreamo'].map(name => fileURLToPath(new URL(`../../runtimes/${name}/src`, import.meta.url))).join(delimiter);
  const result = await promisify(execFile)(python, [fileURLToPath(new URL('./dreamo_runtime_probe.py', import.meta.url))], {
    env: { ...process.env, PYTHONPATH: source, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  expect(result.stdout).toContain('independent indices and cancellation passed');
});
