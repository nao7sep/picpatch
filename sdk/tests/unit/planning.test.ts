import type { EditResult } from '../../src/contracts.generated.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageClient, listModels, type ModelCapabilities, type EditInput } from '../../src/index.ts';
import { ImageClientImpl } from '../../src/execution/session.ts';
import type { EditBackend } from '../../src/execution/backend.ts';
import type { ImageRequest } from '../../src/types.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-plan-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const caps: ModelCapabilities = { model: 'test', instructionEditing: true, textToImage: true, referenceRoles: ['subject', 'style'], maskMode: 'composite', outpainting: true, controlKinds: ['canny'], defaultOutputSize: { width: 32, height: 32 }, parameters: { steps: { default: 4, minimum: 1, integer: true } } };
const image = (path: string, color = 'blue', width = 32, height = 32) => sharp({ create: { width, height, channels: 3, background: color } }).png({ compressionLevel: 0 }).toFile(path);
function setup(capabilities = caps) {
  const render = vi.fn(async (input: ImageRequest): Promise<EditResult> => {
    await image(input.outputPath, 'red', input.size!.width, input.size!.height);
    return { image: { path: input.outputPath, mimeType: 'image/png', size: input.size! }, model: input.model, seed: input.seed!, effectiveParameters: input.parameters ?? {}, modelRevision: 'test', runtime: { name: 'test', version: '1' }, references: [] };
  });
  const backend: EditBackend = { describe: () => capabilities, validate: vi.fn(async () => capabilities), generate: render, edit: render, dispose: vi.fn(async () => {}) };
  return { editor: new ImageClientImpl(backend, { outputDirectory: directory }, 'test'), render, backend };
}
it('fixes seed, parameters and output once, creates no files during planning and executes that decision', async () => {
  const { editor, render, backend } = setup();
  try {
    const plan = await editor.plan({ prompt: 'A bowl.' });
    if (plan.status !== 'completed') throw new Error(plan.code);
    expect(plan.request).toMatchObject({ size: { width: 32, height: 32 }, parameters: { steps: 4 }, seed: expect.any(Number) });
    expect(await readdir(directory)).toEqual([]); expect(backend.validate).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
    expect(() => { plan.request.seed = 99; }).toThrow();
    const saved = await editor.generate(plan);
    expect(saved).toMatchObject({ seed: plan.request.seed, effectiveParameters: plan.request.parameters, image: { path: plan.request.outputPath } });
    await expect(editor.generate(plan)).resolves.toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' });
    expect(render).toHaveBeenCalledTimes(1);
    await expect(editor.generate(structuredClone(plan))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  } finally { await editor.dispose(); }
});
it.each(['source', 'mask', 'reference', 'control'] as const)('refuses changed %s bytes before inference and removes private staging', async role => {
  const { editor, render } = setup(); const path = join(directory, 'input.png'); await image(path);
  const source = join(directory, 'source.png'); await image(source);
  if (role === 'mask') await sharp({ create: { width: 32, height: 32, channels: 3, background: 'black' } }).toColourspace('b-w').png({ compressionLevel: 0 }).toFile(path);
  const input: EditInput = { instruction: 'Edit bowl.', sourceImage: role === 'source' ? path : source,
    ...(role === 'mask' ? { maskImage: path } : {}), ...(role === 'reference' ? { references: [{ id: 'subject', role: 'subject' as const, images: [path] as [string] }] } : {}), ...(role === 'control' ? { control: { kind: 'canny' as const, image: path } } : {}) };
  try {
    const plan = await editor.plan(input); if (plan.status !== 'completed') throw new Error(plan.code);
    const before = await readFile(path);
    expect(plan.inputs.find(input => input.path === path)!.fingerprint.sha256).toBe(createHash('sha256').update(before).digest('hex'));
    if (role === 'mask') await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).toColourspace('b-w').png({ compressionLevel: 0 }).toFile(path); else await image(path, 'red');
    expect((await readFile(path)).length).toBe(before.length);
    await expect(editor.edit(plan)).resolves.toMatchObject({ status: 'refused', code: 'INPUTS_CHANGED', subject: path, details: {} });
    expect(render).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual(['input.png', 'source.png']);
  } finally { await editor.dispose(); }
});
it('refuses a removed input and a retargeted destination, and rejects plans from other editors', async () => {
  const a = setup(); const b = setup(); const source = join(directory, 'source.png'); await image(source);
  const first = join(directory, 'first'); const second = join(directory, 'second'); const alias = join(directory, 'alias'); await mkdir(first); await mkdir(second); await symlink(first, alias);
  try {
    const plan = await a.editor.plan({ instruction: 'A bowl.', sourceImage: source, outputDirectory: alias }); if (plan.status !== 'completed') throw new Error(plan.code);
    await expect(b.editor.edit(plan)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await unlink(alias); await symlink(second, alias);
    await expect(a.editor.edit(plan)).resolves.toMatchObject({ status: 'refused', code: 'DESTINATION_CHANGED' });
    const next = await a.editor.plan({ instruction: 'A bowl.', sourceImage: source }); if (next.status !== 'completed') throw new Error(next.code);
    await unlink(source);
    await expect(a.editor.edit(next)).resolves.toMatchObject({ status: 'refused', code: 'INPUTS_CHANGED' });
    expect(a.render).not.toHaveBeenCalled(); expect(b.render).not.toHaveBeenCalled();
  } finally { await a.editor.dispose(); await b.editor.dispose(); }
});
it('plans real Klein geometry and profile defaults without an engine or model files', async () => {
  const entry = listModels()[0]!; if (entry.acquisition !== 'pinned') throw new Error('Expected pinned model');
  const source = join(directory, 'source.png'); await image(source, 'blue', 1050, 800);
  const editor = createImageClient({ profile: { engineDirectory: join(directory, 'absent-engine'), defaults: { outputDirectory: directory, seed: 7, parameters: { steps: 2 } } }, defaults: { seed: 8 }, model: { variant: entry.variant, directory: join(directory, 'absent-model'), manifest: entry.manifest } });
  try {
    const plan = await editor.plan({ instruction: 'A bowl.', sourceImage: source }); if (plan.status !== 'completed') throw new Error(plan.code);
    expect(plan.request.seed).toBe(8); expect(plan.request.parameters?.steps).toBe(2);
    expect(plan.inputs[0]!.geometry.preparedSize).toEqual({ width: 1040, height: 800 });
    expect(await readdir(directory)).toEqual(['source.png']);
    await expect(editor.plan({ instruction: 'A bowl.', sourceImage: source }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally { await editor.dispose(); }
});
it('plans source-sized masks and canvas placement with the same geometry constraints as execution', async () => {
  const { editor } = setup(); const source = join(directory, 'source.png'); await image(source, 'blue', 48, 32);
  const mask = join(directory, 'mask.png'); await sharp({ create: { width: 48, height: 32, channels: 3, background: 'white' } }).toColourspace('b-w').png().toFile(mask);
  try {
    const plan = await editor.plan({ instruction: 'A bowl.', sourceImage: source, maskImage: mask });
    expect(plan).toMatchObject({ request: { size: { width: 48, height: 32 } } });
    await expect(editor.plan({ instruction: 'A bowl.', sourceImage: source, outpaint: { size: { width: 32, height: 32 }, left: 0, top: 0 } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  } finally { await editor.dispose(); }
});
it('plans a missing output folder without creating it, then creates it with its parents before writing', async () => {
  const { editor } = setup();
  const nested = join(directory, 'new', 'deeper');
  try {
    const plan = await editor.plan({ prompt: 'A bowl.', outputDirectory: nested });
    if (plan.status !== 'completed') throw new Error(plan.code);
    expect(await readdir(directory)).toEqual([]);
    const saved = await editor.generate(plan);
    if (saved.status !== 'completed') throw new Error(saved.code);
    expect(await readdir(nested)).toEqual([saved.image.path.slice(nested.length + 1)]);
  } finally { await editor.dispose(); }
});
it('refuses a plan whose existing output folder was replaced', async () => {
  const { editor, render } = setup();
  const folder = join(directory, 'out'); await mkdir(folder);
  try {
    const plan = await editor.plan({ prompt: 'A bowl.', outputDirectory: folder });
    if (plan.status !== 'completed') throw new Error(plan.code);
    await rm(folder, { recursive: true }); await mkdir(folder);
    await expect(editor.generate(plan)).resolves.toMatchObject({ status: 'refused', code: 'DESTINATION_CHANGED' });
    expect(render).not.toHaveBeenCalled();
  } finally { await editor.dispose(); }
});
