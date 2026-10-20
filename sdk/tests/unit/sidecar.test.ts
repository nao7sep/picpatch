import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImageClientImpl } from '../../src/execution/session.ts';
import type { EditBackend } from '../../src/execution/backend.ts';
import { contractValidator } from '../../src/contracts.ts';
import { validateGenerateRequest, validateEditRequest, type ArtifactRecord, type SdkEvent, type EditResult } from '../../src/index.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
let directory: string;
let source: string;
let output: string;
let png: Buffer;
let editor: ImageClientImpl;
let beforeRender: (() => Promise<void>) | undefined;
const events: SdkEvent[] = [];
beforeEach(async () => {
  vi.mocked(fs.link).mockImplementation(actual.link);
  vi.mocked(fs.open).mockImplementation(actual.open);
  directory = await fs.mkdtemp(join(tmpdir(), 'picpatch-sidecar-'));
  source = join(directory, 'source.png'); output = join(directory, 'out.png');
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  await fs.writeFile(source, png); beforeRender = undefined; events.length = 0;
  const backend: EditBackend = {
    validate: async request => {
      if ('prompt' in request) validateGenerateRequest(request); else validateEditRequest(request);
      return { model: 'test', instructionEditing: true, textToImage: true, referenceRoles: ['style'], maskMode: 'none' };
    },
    edit: async request => {
      expect(request).not.toHaveProperty('sidecar');
      await beforeRender?.(); await fs.writeFile(request.outputPath, png);
      return { model: 'test', modelRevision: 'revision', runtime: { name: 'fixture', version: '1' }, seed: 42,
        effectiveParameters: { steps: 7, negativePrompt: 'private-negative' }, references: [],
        image: { path: request.outputPath, mimeType: 'image/png', size: { width: 8, height: 8 } } };
    },
    generate: async request => {
      expect(request).not.toHaveProperty('sidecar');
      await beforeRender?.(); await fs.writeFile(request.outputPath, png);
      return { model: 'test', modelRevision: 'revision', runtime: { name: 'fixture', version: '1' }, seed: 42,
        effectiveParameters: { steps: 7, negativePrompt: 'private-negative' }, references: [],
        image: { path: request.outputPath, mimeType: 'image/png', size: { width: 8, height: 8 } } };
    }, dispose: async () => {},
  };
  editor = new ImageClientImpl(backend, {}, 'test');
});
afterEach(async () => { await editor.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
async function record(saved: EditResult): Promise<ArtifactRecord> {
  expect(saved.sidecar).toEqual({ status: 'saved', path: join(directory, 'out-picpatchsdk.json') });
  const json = await fs.readFile(join(directory, 'out-picpatchsdk.json'), 'utf8');
  const data = JSON.parse(json) as ArtifactRecord;
  expect(contractValidator('ArtifactRecord')(data)).toBe(true);
  const image = await fs.readFile(output);
  expect(data.sha256).toBe(createHash('sha256').update(image).digest('hex'));
  expect(data.bytes).toBe(image.length);
  expect(data.image).not.toHaveProperty('path');
  expect(json).not.toContain(directory);
  expect(data.image.filename).toBe('out.png');
  expect(data.effectiveParameters.steps).toBe(7);
  expect(data.seed).toBe(42);
  expect(json).not.toContain('.picpatch-');
  // Windows has no POSIX mode bits.
  if (process.platform !== 'win32') expect((await fs.stat(join(directory, 'out-picpatchsdk.json'))).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
  return data;
}

it.each(['edit', 'generate'] as const)('writes no sidecar unless %s explicitly requests it', async verb => {
  const saved = verb === 'edit' ? await editor.edit({ instruction: 'private-instruction', sourceImage: source, outputPath: output })
    : await editor.generate({ prompt: 'private-prompt', outputPath: output });
    if ('status' in saved) throw new Error(saved.code);
  expect(saved).not.toHaveProperty('sidecar');
  expect(saved.record.writer).toEqual({ name: 'picpatchsdk', version: '0.0.0' });
  expect(saved.record.fingerprints).toHaveLength(verb === 'edit' ? 1 : 0);
  expect(await fs.readdir(directory)).toEqual(['out.png', 'source.png']);
});

it.each([false, true])('retains edit inputs only with explicit content consent (%s)', async includeInputs => {
  const references = [{ id: 'private-id', role: 'style' as const, images: [source] as [string] }] as const;
  const saved = await editor.edit({ instruction: 'private-instruction', sourceImage: source, references: [...references], outputPath: output, sidecar: { includeInputs } }, { onEvent: event => events.push(event) });
  if ('status' in saved) throw new Error(saved.code);
  const data = await record(saved);
  expect(data.inputsIncluded).toBe(includeInputs);
  if (includeInputs) {
    expect(data.inputs).toMatchObject({ instruction: 'private-instruction', sourceImage: 'source.png', references: [{ id: 'private-id', role: 'style', images: ['source.png'] }] });
    expect(data.inputs?.geometry?.[0]).not.toHaveProperty('path');
    expect(data.inputs?.geometry?.[0]?.filename).toBe('source.png');
    expect(data.inputs?.geometry?.[0]?.preparedSize).toEqual({ width: 8, height: 8 });
    expect(data.effectiveParameters.negativePrompt).toBe('private-negative');
  } else {
    expect(data).not.toHaveProperty('inputs');
    expect(JSON.stringify(data)).not.toMatch(/private-|source.png/);
  }
  expect(JSON.stringify(events)).not.toMatch(/private-|source.png/);
});

it.each([false, true])('writes generation provenance with optional prompt (%s)', async includeInputs => {
  const saved = await editor.generate({ prompt: 'private-prompt', outputPath: output, sidecar: includeInputs ? { includeInputs } : {} });
  if ('status' in saved) throw new Error(saved.code);
  const data = await record(saved);
  expect(data.operation).toBe('generate');
  if (includeInputs) expect(data.inputs).toEqual({ prompt: 'private-prompt' });
  else expect(JSON.stringify(data)).not.toContain('private-');
});

it('rejects malformed sidecar options through both public request validators', () => {
  for (const sidecar of [true, null, [], { includeInputs: 'yes' }, { path: '/other.json' }]) {
    expect(() => validateGenerateRequest({ model: 'test', prompt: 'Blue', outputPath: output, sidecar })).toThrow();
    expect(() => validateEditRequest({ model: 'test', instruction: 'Blue', sourceImage: source, outputPath: output, sidecar })).toThrow();
  }
});

it.each(['file', 'symlink'])('keeps an existing sidecar %s while publishing the image', async kind => {
  if (kind === 'file') await fs.writeFile(join(directory, 'out-picpatchsdk.json'), 'existing');
  else await fs.symlink(join(directory, 'absent.json'), join(directory, 'out-picpatchsdk.json'));
  beforeRender = vi.fn();
  await expect(editor.generate({ prompt: 'Blue', outputPath: output, sidecar: {} })).resolves.toMatchObject({ sidecar: { status: 'failed', code: 'OUTPUT_CONFLICT' }, record: { writer: { name: 'picpatchsdk' } } });
  expect(beforeRender).toHaveBeenCalled();
  expect((await sharp(output).metadata()).format).toBe('png');
});

it('reports a racing sidecar conflict without overwriting it or deleting the saved PNG', async () => {
  beforeRender = () => fs.writeFile(join(directory, 'out-picpatchsdk.json'), 'another writer');
  const saved = await editor.generate({ prompt: 'Blue', outputPath: output, sidecar: {} });
  if ('status' in saved) throw new Error(saved.code);
  expect(saved.sidecar).toMatchObject({ status: 'failed', code: 'OUTPUT_CONFLICT', effect: 'none', path: join(directory, 'out-picpatchsdk.json') });
  expect(await fs.readFile(join(directory, 'out-picpatchsdk.json'), 'utf8')).toBe('another writer');
  expect((await sharp(output).metadata()).format).toBe('png');
  expect((await fs.readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
});

it('reports a metadata write error as partial success with safe copy', async () => {
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/sidecar.json')) throw Object.assign(new Error('private filesystem detail'), { code: 'ENOSPC' });
    return actual.open(...args);
  });
  const saved = await editor.generate({ prompt: 'Blue', outputPath: output, sidecar: {} });
  if ('status' in saved) throw new Error(saved.code);
  expect(saved.sidecar).toMatchObject({ status: 'failed', code: 'DISK_FULL', effect: 'none' });
  expect(JSON.stringify(saved.sidecar)).not.toContain('private filesystem detail');
  expect((await sharp(output).metadata()).format).toBe('png');
  await expect(fs.stat(join(directory, 'out-picpatchsdk.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels before publication without artifacts, but settles both files after the image commit', async () => {
  const early = new AbortController(); beforeRender = async () => { early.abort(); };
  await expect(editor.generate({ prompt: 'Blue', outputPath: output, sidecar: {} }, { signal: early.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await fs.readdir(directory)).toEqual(['source.png']);
  beforeRender = undefined;
  const late = new AbortController();
  vi.mocked(fs.link).mockImplementation(async (...args) => {
    await actual.link(...args);
    if (args[1] === output) late.abort();
  });
  const saved = await editor.generate({ prompt: 'Blue', outputPath: output, sidecar: {} }, { signal: late.signal });
  if ('status' in saved) throw new Error(saved.code);
  await record(saved);
});

it('rejects filesystem path fields in the sidecar schema', async () => {
  const saved = await editor.edit({ instruction: 'Blue', sourceImage: source, references: [{ id: 'ref', role: 'style', images: [source] }], outputPath: output, sidecar: { includeInputs: true } });
  if ('status' in saved) throw new Error(saved.code);
  const data = await record(saved);
  const valid = contractValidator('ArtifactRecord');
  for (const path of ['/Users/example/private.png', 'C:\\Users\\example\\private.png', '../private.png']) {
    expect(valid({ ...data, image: { ...data.image, path } })).toBe(false);
    expect(valid({ ...data, inputs: { ...data.inputs, sourcePath: path } })).toBe(false);
    expect(valid({ ...data, inputs: { ...data.inputs, references: [{ id: 'ref', role: 'style', images: ['source.png'], path }] } })).toBe(false);
    expect(valid({ ...data, inputs: { ...data.inputs, geometry: [{ ...data.inputs!.geometry![0], path }] } })).toBe(false);
  }
});

it('reports uncertain sidecar publication without deleting either complete file', async () => {
  vi.mocked(fs.link).mockImplementation(async (...args) => {
    await actual.link(...args);
    if (String(args[1]).endsWith('.json')) throw Object.assign(new Error('uncertain publication'), { code: 'EIO' });
  });
  const saved = await editor.generate({ prompt: 'Blue', outputPath: output, sidecar: {} });
  if ('status' in saved) throw new Error(saved.code);
  expect(saved.sidecar).toMatchObject({ status: 'failed', code: 'IO_ERROR', effect: 'unknown' });
  expect((await sharp(output).metadata()).format).toBe('png');
  expect(JSON.parse(await fs.readFile(join(directory, 'out-picpatchsdk.json'), 'utf8')).version).toBe(1);
});
