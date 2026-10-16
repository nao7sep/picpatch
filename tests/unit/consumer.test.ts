import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-consumer-'));
  vi.stubEnv('PICPATCH_DATA_DIR', join(directory, 'data'));
  vi.stubEnv('PICPATCH_MODELS_DIR', join(directory, 'models'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Read-only operations must not fetch.'); }));
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

it('imports and uses the public read-only journey without creating owned storage or fetching', async () => {
  vi.resetModules();
  const sdk = await import('picpatch');
  const selected = sdk.listModels()[0]!;
  expect(sdk.resolveStoragePaths()).toEqual({ dataDirectory: join(directory, 'data'), modelsDirectory: join(directory, 'models') });
  expect(await sdk.discoverModels()).toEqual({ models: [] });
  await expect(sdk.prepareModel(selected.id, { download: false })).rejects.toMatchObject({ code: 'MODEL_IO' });
  const editor = sdk.createEditor({ pythonExecutable: join(directory, 'absent-python') });
  await editor.dispose();
  expect(await readdir(directory)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it('inspects and verifies an external fixture without modifying it or loading incomplete models', async () => {
  const sdk = await import('picpatch');
  const external = join(directory, 'external');
  await mkdir(external);
  const bytes = Buffer.from('neutral local fixture');
  const path = join(external, 'weights.safetensors');
  await writeFile(path, bytes);
  const manifest: import('picpatch').ModelManifest = {
    version: 1, model: 'fixture', source: { repository: 'fixture', revision: 'a'.repeat(40) },
    components: [{ path: 'weights.safetensors', role: 'weights', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  };
  expect((await sdk.inspectModel(external)).path).toBe(external);
  expect((await sdk.discoverModels([external])).models).toHaveLength(1);
  expect((await sdk.verifyModel(external, manifest)).status).toBe('matches-manifest');
  const readiness = await sdk.inspectReadiness(join(directory, 'absent-python'), {
    adapter: 'mflux-flux2-klein-4b', directory: join(directory, 'missing'), manifest,
  }, { verify: true, load: true });
  expect(readiness).toMatchObject({ files: 'incomplete', integrity: 'invalid', runtime: { status: 'not-checked' } });
  expect(await readFile(path)).toEqual(bytes);
  expect(await readdir(external)).toEqual(['weights.safetensors']);
  expect(await readdir(directory)).toEqual(['external']);
  expect(fetch).not.toHaveBeenCalled();
});
