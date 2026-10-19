import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('checks Ideogram 4 local components and constant-guidance execution without trained weights', async () => {
  const config = JSON.parse(await readFile(process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url)), 'utf8'));
  await promisify(execFile)(config.pythonExecutable, [fileURLToPath(new URL('./ideogram4_api_probe.py', import.meta.url))], {
    timeout: 30_000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url)), fileURLToPath(new URL('../../runtimes/common/src', import.meta.url))].join(':'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
}, 60_000);
