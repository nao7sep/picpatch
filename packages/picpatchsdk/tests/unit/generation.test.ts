import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEditor, validateGenerateRequest, type SdkEvent, type GenerateRequest, type EditResult, type ModelCapabilities } from '../../src/index.ts';
import { resolveGenerateRequest } from '../../src/defaults.ts';
import { ImageEditor } from '../../src/execution/session.ts';
import type { EditBackend } from '../../src/execution/backend.ts';
import { PicPatchSdkError } from '../../src/errors.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-generate-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const capabilities: ModelCapabilities = { model: 'test', instructionEditing: true, textToImage: true, referenceRoles: [], maskMode: 'none', size: { widthMultiple: 16, heightMultiple: 16 } };
function request(): GenerateRequest { return { model: 'test', prompt: 'A ceramic bowl.', seed: 0, size: { width: 32, height: 16 }, outputPath: join(directory, 'out.png') }; }
async function render(input: GenerateRequest): Promise<EditResult> {
  await sharp({ create: { width: 32, height: 16, channels: 3, background: 'blue' } }).png().toFile(input.outputPath);
  return { image: { path: input.outputPath, mimeType: 'image/png', size: { width: 32, height: 16 } }, model: input.model, seed: input.seed ?? 0, effectiveParameters: {}, modelRevision: 'test-revision', runtime: { name: 'test', version: '1' }, references: [] };
}
function backend(generate: EditBackend['generate'] = render): EditBackend {
  return { validate: async () => capabilities, generate, edit: async () => { throw new Error('Unexpected edit'); }, dispose: async () => {} };
}
it('validates generation separately, requires support, and rejects image-conditioning fields', () => {
  expect(validateGenerateRequest(request(), capabilities)).toEqual(request());
  for (const change of [{ prompt: '' }, { prompt: ' ' }, { sourceImage: '/source.png' }, { references: [] }, { maskImage: '/mask.png' }, { instruction: 'edit' }, { outputPath: 'relative.png' }, { seed: -1 }, { outputPath: '/out.jpg' }]) {
    expect(() => validateGenerateRequest({ ...request(), ...change })).toThrow();
  }
  const { textToImage: _support, ...unsupported } = capabilities;
  for (const model of [unsupported, { ...unsupported, textToImage: false }]) expect(() => validateGenerateRequest(request(), model)).toThrow();
  expect(() => validateGenerateRequest({ ...request(), size: { width: 17, height: 16 } }, capabilities)).toThrow();
});
it('resolves defaults with explicit seed zero, unique names, and no implicit destination', () => {
  const defaults = { size: { width: 32, height: 16 }, seed: 9, outputDirectory: directory };
  const first = resolveGenerateRequest({ prompt: 'A bowl.', seed: 0 }, defaults, 'test');
  expect(first).toMatchObject({ model: 'test', seed: 0, size: defaults.size });
  expect(first.outputPath).toMatch(/generate-[a-f0-9-]+\.png$/);
  expect(resolveGenerateRequest({ prompt: 'A bowl.' }, defaults, 'test').outputPath).not.toBe(first.outputPath);
  expect(() => resolveGenerateRequest({ prompt: 'A bowl.' }, {}, 'test')).toThrow();
  expect(() => resolveGenerateRequest({ ...request(), model: 'other' }, defaults, 'test')).toThrow();
  expect(() => resolveGenerateRequest({ ...request(), outputDirectory: directory }, defaults, 'test')).toThrow();
});
it('publishes generation through shared safe storage without fabricated inputs or prompt diagnostics', async () => {
  const events: SdkEvent[] = [];
  const generate = vi.fn(async (input: GenerateRequest) => {
    expect(await readdir(join(input.outputPath, '..'))).toEqual([]);
    expect(input.outputPath).not.toBe(request().outputPath);
    return render(input);
  });
  const editor = new ImageEditor(backend(generate));
  try {
    const result = await editor.generate(request(), { onEvent: event => events.push(event) });
    if ('status' in result) throw new Error(result.code);
    expect(result).toMatchObject({ image: { path: request().outputPath }, references: [], inputGeometry: [], seed: 0 });
    expect(await readdir(directory)).toEqual(['out.png']);
    expect((await sharp(result.image.path).metadata()).width).toBe(32);
    expect(events.every(event => event.verb === 'generate')).toBe(true);
    expect(events.at(-1)?.stage).toBe('succeeded');
    expect(JSON.stringify(events)).not.toContain(request().prompt);
    const saved = await readFile(result.image.path);
    await expect(editor.generate(request())).resolves.toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' });
    expect(await readFile(result.image.path)).toEqual(saved);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { await editor.dispose(); }
});
it('rejects malformed generated output and cleans private storage', async () => {
  const editor = new ImageEditor(backend(async input => { const result = await render(input); await writeFile(input.outputPath, 'invalid'); return result; }));
  try { await expect(editor.generate(request())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' }); expect(await readdir(directory)).toEqual([]); }
  finally { await editor.dispose(); }
});
it('shares queued/disposal ownership across edit and generation and waits before cleanup', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const editor = new ImageEditor(backend(async () => { entered.resolve(); await release.promise; throw new PicPatchSdkError('CANCELLED', 'The operation was cancelled.'); }));
  const operation = editor.generate(request()); const caught = expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
  await entered.promise;
  const waiting = editor.generate({ ...request(), outputPath: join(directory, 'queued.png') });
  const waitingCancelled = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
  let disposed = false; const disposal = editor.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false);
  release.resolve(); await caught; await waitingCancelled; await disposal;
  expect(await readdir(directory)).toEqual([]);
  await expect(editor.generate(request())).rejects.toMatchObject({ code: 'DISPOSED' });
});
it('rejects invalid public calls and pre-cancellation without starting Python', async () => {
  const editor = createEditor({ engineDirectory: '/absent/python' });
  try {
    await expect(editor.generate({ ...request(), prompt: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(editor.generate({ ...request(), outputPath: null } as unknown as GenerateRequest)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(editor.generate(request(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(directory)).toEqual([]);
  } finally { await editor.dispose(); }
});
