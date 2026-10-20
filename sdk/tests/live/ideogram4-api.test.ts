import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { inferenceConfig } from '../helpers/live-cache.ts';

it('checks Ideogram 4 local components and constant-guidance execution without trained weights', async () => {
  const config = await inferenceConfig();
  await promisify(execFile)(config.pythonExecutable, [fileURLToPath(new URL('./ideogram4_api_probe.py', import.meta.url))], {
    timeout: 30_000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url)), fileURLToPath(new URL('../../runtimes/common/src', import.meta.url))].join(':'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
}, 60_000);
