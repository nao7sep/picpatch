import { expect, it } from 'vitest';
import { WorkerProcess, workerTimeouts } from '../../src/worker/process.ts';
import { workerLaunch } from '../../src/backends/python/launch.ts';
import type { LocalModel } from '../../src/contracts.generated.ts';
import { liveCache } from '../helpers/live-cache.ts';

it('launches bundled Python entries with a real model-bound handshake and confirmed shutdown without weights', async () => {
  const cases = [
    { runtime: 'mflux' as const, variant: 'flux2-klein-4b' as const, python: process.env.PICPATCH_MFLUX_PYTHON ?? liveCache('runtime-py315/bin/python') },
    { runtime: 'diffusers' as const, variant: 'glm-image' as const, python: process.env.PICPATCH_DIFFUSERS_PYTHON ?? liveCache('diffusers-audit/venv/bin/python') },
    { runtime: 'dreamo' as const, variant: 'flux1-dreamo-v1.1' as const, python: process.env.PICPATCH_DREAMO_PYTHON ?? liveCache('dreamo-audit/venv/bin/python') },
  ];
  for (const entry of cases) {
    const model: LocalModel = { variant: entry.variant, directory: '/not-loaded', manifest: { version: 1, model: entry.variant, source: { repository: 'local', revision: 'a'.repeat(40) }, components: [{ path: 'weights.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] } };
    const worker = new WorkerProcess({ ...workerLaunch(entry.python, undefined, entry.runtime), model }, workerTimeouts);
    try {
      const ready = await worker.start();
      expect(ready.type).toBe('ready');
      if (ready.type !== 'ready') throw new Error('Expected worker handshake');
      expect(ready.models).toHaveLength(1);
      expect(ready.models[0]!.model).toBe(entry.variant);
      expect(ready.models[0]!.referenceConditioning).toBe(entry.runtime === 'dreamo' ? 'independent-subject' : 'ordered-images-with-role-prompt');
    } finally { await worker.dispose(); }
  }
}, 60_000);
