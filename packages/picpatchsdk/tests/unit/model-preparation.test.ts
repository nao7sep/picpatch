import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listModels, prepareModel as preparePublicModel, inspectReadiness } from '../../src/index.ts';
import { prepareCatalogModel as prepareCatalog } from '../../src/models/preparation.ts';
import { downloadFile } from '../../src/models/download.ts';
import type { CatalogModel } from '../../src/models/catalog.ts';

let directory: string;
let entry: CatalogModel;
const storage = () => ({ modelsDirectory: join(directory, 'models') });
const prepareModel: typeof preparePublicModel = (id, options = {}) => preparePublicModel(id, { storage: storage(), ...options });
const prepareCatalogModel: typeof prepareCatalog = (entry, options, fetcher) => prepareCatalog(entry, { storage: storage(), ...options }, fetcher);
const bytes = Buffer.from('small fixture');
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-prepare-'));
  vi.stubEnv('PICPATCH_DATA_DIR', join(directory, 'data'));
  vi.stubEnv('PICPATCH_MODELS_DIR', join(directory, 'models'));
  entry = { ...listModels().find(model => model.acquisition === 'pinned')!, id: 'fixture', downloadBytes: bytes.length, manifest: {
    version: 1, model: 'fixture', source: { repository: 'test/fixture', revision: 'a'.repeat(40) },
    components: [{ path: 'weights.safetensors', role: 'weights', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  } };
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const source = (): typeof fetch => vi.fn(async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));

it('lists independent immutable pins, source, license, runtime and total size', () => {
  const model = listModels().find(model => model.acquisition === 'pinned')!;
  expect(model.downloadBytes).toBe(model.manifest.components.reduce((sum, c) => sum + c.bytes, 0));
  expect(model).toMatchObject({ status: 'experimental', license: { id: 'Apache-2.0' }, runtime: { version: '0.22.0' } });
  model.manifest.components.length = 0;
  expect(listModels().find(model => model.acquisition === 'pinned')!.manifest.components.length).toBeGreaterThan(0);
});
it('requires explicit acquisition and rejects unknown catalog IDs without creating storage', async () => {
  await expect(prepareModel(listModels().find(model => model.acquisition === 'pinned')!.id)).rejects.toMatchObject({ code: 'MODEL_IO' });
  await expect(prepareModel('unknown', { download: true })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  expect(await readdir(directory)).toEqual([]);
});
it('publishes only verified bundles, tightens permissions and reuses without fetching', async () => {
  const fetcher = source();
  await mkdir(join(directory, 'models'), { mode: 0o755 });
  const prepared = await prepareCatalogModel(entry, { download: true }, fetcher);
  expect(prepared).toMatchObject({ origin: 'download', integrity: 'matches-manifest' });
  expect(await readFile(join(prepared.model.directory, 'weights.safetensors'))).toEqual(bytes);
  if (process.platform !== 'win32') expect((await stat(join(directory, 'models'))).mode & 0o777).toBe(0o700);
  expect(await readdir(join(directory, 'models', 'fixture'))).toEqual(['a'.repeat(40)]);
  expect((await prepareCatalogModel(entry, {}, fetcher)).origin).toBe('cache');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await writeFile(join(prepared.model.directory, 'weights.safetensors'), 'corrupt');
  await expect(prepareCatalogModel(entry, { download: true }, fetcher)).rejects.toMatchObject({ code: 'MODEL_IO' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await readFile(join(prepared.model.directory, 'weights.safetensors'), 'utf8')).toBe('corrupt');
});
it('verifies an external bundle in place without creating managed storage', async () => {
  const external = join(directory, 'external'); await mkdir(external);
  await writeFile(join(external, 'weights.safetensors'), bytes);
  const fetcher = source();
  const prepared = await prepareCatalogModel(entry, { directory: external }, fetcher);
  expect(prepared).toMatchObject({ origin: 'external', model: { directory: external } });
  expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual(['external']);
});
it.each(['digest', 'short', 'oversized', 'unavailable', 'redirect'])('rejects %s acquisition and removes staging', async failure => {
  const fetcher: typeof fetch = async () => failure === 'redirect' ? new Response(null, { status: 302, headers: { location: 'http://unsafe/file' } }) :
    failure === 'unavailable' ? new Response(null, { status: 404 }) : new Response(failure === 'digest' ? 'x'.repeat(bytes.length) : failure === 'short' ? 'x' : 'x'.repeat(bytes.length + 1));
  await expect(prepareCatalogModel(entry, { download: true }, fetcher)).rejects.toMatchObject({ code: 'MODEL_IO' });
  expect(await readdir(join(directory, 'models', 'fixture'))).toEqual([]);
});
it('cancels at a component boundary with no publication or leftover staging', async () => {
  const controller = new AbortController(); const fetcher = source();
  await expect(prepareCatalogModel(entry, { download: true, signal: controller.signal, onProgress: event => {
    if (event.stage === 'downloading') controller.abort();
  } }, fetcher)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readdir(join(directory, 'models', 'fixture'))).toEqual([]);
});
it('allows concurrent equivalent preparations and preserves one complete winner', async () => {
  const results = await Promise.all([prepareCatalogModel(entry, { download: true }, source()), prepareCatalogModel(entry, { download: true }, source())]);
  expect(results[0]!.model.directory).toBe(results[1]!.model.directory);
  expect(await readdir(join(directory, 'models', 'fixture'))).toEqual(['a'.repeat(40)]);
  expect(await readFile(join(results[0]!.model.directory, 'weights.safetensors'))).toEqual(bytes);
});
it('rejects unsafe manifests and external acquisition before writing', async () => {
  entry.manifest.components[0]!.path = '../escape';
  await expect(prepareCatalogModel(entry, { download: true }, source())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(prepareModel(listModels().find(model => model.acquisition === 'pinned')!.id, { download: true, directory })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('reports incomplete files separately and avoids starting a worker', async () => {
  const model = { variant: entry.variant, directory, manifest: entry.manifest };
  expect(await inspectReadiness('/unused/python', model, { verify: true })).toEqual({ files: 'incomplete', integrity: 'invalid', runtime: { status: 'not-checked' }, capabilities: [] });
  await writeFile(join(directory, 'weights.safetensors'), 'x'.repeat(bytes.length));
  expect(await inspectReadiness('/unused/python', model, { verify: true })).toMatchObject({ files: 'present', integrity: 'invalid', runtime: { status: 'not-checked' } });
});
it('validates readiness switches and pre-cancellation before reads', async () => {
  const model = { variant: entry.variant, directory, manifest: entry.manifest };
  await expect(inspectReadiness('/unused', model, { load: 'yes' } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(inspectReadiness('/unused', model, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
});
it('does not follow a downgrade redirect or contact the next endpoint', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://unsafe/file' } }));
  await expect(downloadFile('https://source/file', join(directory, 'file'), 1, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'MODEL_IO' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('preserves existing files when the selected model store is unusable', async () => {
  await writeFile(join(directory, 'models'), 'caller data');
  const fetcher = source();
  await expect(prepareCatalogModel(entry, { download: true }, fetcher)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'models'), 'utf8')).toBe('caller data');
});
it('cleans interrupted streams before rejecting preparation', async () => {
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 1)); controller.error(new Error('connection interrupted'));
  } }));
  await expect(prepareCatalogModel(entry, { download: true }, fetcher)).rejects.toMatchObject({ code: 'MODEL_IO' });
  expect(await readdir(join(directory, 'models', 'fixture'))).toEqual([]);
});
it('bounds a stalled body and closes its reader before reporting timeout', async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  try {
    const downloading = downloadFile('https://source/file', join(directory, 'stalled'), 1, new AbortController().signal, fetcher);
    const assertion = expect(downloading).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each([['flux2-klein-base-9b', 50, 4, 9_541_191_203, 'AITRADER/FLUX2-klein-base-9B-mlx-4bit'], ['flux2-klein-9b', 4, 1, 9541224462, 'AITRADER/FLUX2-klein-9B-mlx-4bit']] as const)('pins %s with its architecture, license and sampling defaults', (variant, steps, guidance, bytes, repository) => {
  const selected = listModels().find(model => model.id === `${variant}-4bit`)!;
  expect(selected).toMatchObject({ acquisition: 'pinned', variant, license: { id: 'flux-non-commercial-license' },
    capabilities: { instructionEditing: true, textToImage: true, parameters: { steps: { default: steps }, guidance: { default: guidance } } } });
  if (selected.acquisition !== 'pinned') throw new Error('Expected a pinned bundle');
  expect(selected.downloadBytes).toBe(bytes);
  expect(selected.manifest.source.repository).toBe(repository);
});
