import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { referenceWorkload } from '../../benchmarks/reference-workload.ts';
import { createEditor, listModels, prepareModel, inspectReadiness, discoverModels, resolveStoragePaths, type EditorOptions, type DiagnosticEvent } from '../../src/index.ts';

async function localOptions(): Promise<EditorOptions> {
  const path = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  let options: EditorOptions;
  try { options = JSON.parse(await readFile(path, 'utf8')) as EditorOptions; }
  catch (cause) { throw new Error('Prepare the local inference test cache or set PICPATCH_INFERENCE_CONFIG to an editor-options JSON file. This test never downloads models.', { cause }); }
  if (!options.model) throw new Error('PICPATCH_INFERENCE_CONFIG must include a local model configuration.');
  return options;
}

it('completes the catalog-to-edit consumer journey with existing weights and isolated owned storage', async () => {
  const options = await localOptions();
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-inference-'));
  vi.stubEnv('PICPATCH_DATA_DIR', join(directory, 'data'));
  vi.stubEnv('PICPATCH_MODELS_DIR', join(directory, 'models'));
  const events: DiagnosticEvent[] = [];
  let editor: ReturnType<typeof createEditor> | undefined;
  const paths: string[] = [];
  try {
    // The harness supplies only existing filesystem locations. Consumer code uses public operations.
    const selected = listModels().find(entry => entry.id === options.model!.manifest.model)!;
    expect(selected).toBeDefined();
    expect(resolveStoragePaths().modelsDirectory).toBe(join(directory, 'models'));
    expect(await discoverModels()).toEqual({ models: [] });
    await expect(prepareModel(selected.id)).rejects.toMatchObject({ code: 'MODEL_IO' });
    const prepared = await prepareModel(selected.id, { directory: options.model!.directory });
    expect(prepared).toMatchObject({ origin: 'external', integrity: 'matches-manifest' });
    expect(await inspectReadiness(options.pythonExecutable!, prepared.model)).toMatchObject({
      files: 'present', runtime: { status: 'imports-ready' },
    });
    editor = createEditor({ pythonExecutable: options.pythonExecutable!, model: prepared.model,
      defaults: { size: { width: 256, height: 256 }, seed: 42, outputDirectory: directory } });
    const images = [join(directory, 'red.png'), join(directory, 'blue.png')];
    await sharp({ create: { width: 271, height: 289, channels: 3, background: 'red' } }).png().toFile(images[0]!);
    await sharp({ create: { width: 257, height: 263, channels: 3, background: 'blue' } }).png().toFile(images[1]!);
    for (let index = 0; index < 2; index++) {
      const result = await editor.edit({
        instruction: 'Combine both colors into a simple striped image.',
        ...(index === 1 ? { sourceImage: paths[0]! } : {}),
        references: [{ id: 'colors', role: 'style', images: [images[0]!, images[1]!] }],
      }, { onDiagnostic: event => events.push(event) });
      paths.push(result.image.path);
      const metadata = await sharp(result.image.path).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 256, height: 256 });
      expect(result.runtime).toEqual({ name: 'mflux', version: '0.22.0' });
      expect(result.seed).toBe(42);
      expect(result.modelRevision).toBe(options.model!.manifest.source.revision);
      expect(result.references[0]?.images).toEqual(images);
      const geometry = result.inputGeometry!.filter(input => images.includes(input.path));
      expect(geometry.map(input => input.preparedSize)).toEqual([{ width: 256, height: 288 }, { width: 256, height: 256 }]);
      expect(geometry.map(input => input.crop)).toEqual([{ left: 7, top: 0 }, { left: 0, top: 3 }]);
      expect(result.image.path).toMatch(/edit-[a-f0-9-]+\.png$/);
    }
    const saved = await readFile(paths[0]!);
    await expect(editor.edit({ instruction: 'Use blue.', sourceImage: images[0]!, outputPath: paths[0]! })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    expect(await readFile(paths[0]!)).toEqual(saved);
    await editor.dispose();
    await expect(editor.edit({ instruction: 'Use blue.', sourceImage: images[0]! })).rejects.toMatchObject({ code: 'DISPOSED' });
    expect((await readdir(directory)).sort()).toEqual(['red.png', 'blue.png', ...paths.map(path => path.split('/').at(-1)!)].sort());
    expect(events.filter(event => event.stage === 'succeeded')).toHaveLength(2);
    expect(new Set(events.map(event => event.operationId)).size).toBe(2);
    expect(JSON.stringify(events)).not.toContain('Combine both colors');
  } finally {
    await editor?.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 3_600_000);

it('cancels after a real denoising step and cleans unpublished output after worker settlement', async () => {
  const options = await localOptions();
  const editor = createEditor(options);
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-cancel-inference-'));
  try {
    const sourceImage = join(directory, 'source.png');
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'red' } }).png().toFile(sourceImage);
    const controller = new AbortController();
    let sawStep = false;
    await expect(editor.edit({ model: options.model!.manifest.model, instruction: 'Make the image blue.',
      sourceImage, size: { width: 256, height: 256 }, seed: 42, outputPath: join(directory, 'cancelled.png'),
    }, { signal: controller.signal, onProgress: event => {
      if (event.stage === 'editing' && event.completed !== undefined && event.completed >= 1) {
        sawStep = true;
        controller.abort();
      }
    } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sawStep).toBe(true);
    await editor.dispose();
    expect(await readdir(directory)).toEqual(['source.png']);
  } finally {
    await editor.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 1_800_000);

it('edits four and six grouped references in one session without changing originals or leaving private output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-references-'));
  try {
    const events: Record<string, unknown>[] = [];
    await referenceWorkload(await localOptions(), directory, 256, 256, [4, 6], event => events.push(event));
    for (const index of [0, 1]) {
      const phases = events.filter(event => event.kind === 'phase' && event.index === index);
      const stages = phases.map(event => event.stage);
      expect(stages).toEqual(expect.arrayContaining(['loading', 'editing', 'saving']));
      expect(stages.filter(stage => stage === 'editing')).toHaveLength(1);
      const elapsed = phases.map(event => event.elapsedSeconds as number);
      expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
      expect(events.find(event => event.kind === 'start' && event.index === index)).toMatchObject({ inputSize: 256, outputSize: 256 });
      expect(events.find(event => event.kind === 'end' && event.index === index)).toMatchObject({ runtime: { name: 'mflux' }, seed: 42 });
    }
    expect(JSON.stringify(events)).not.toContain('wooden table');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 3_600_000);

it('prepares existing catalog weights and checks actual model loading without acquisition', async () => {
  const { prepareModel, inspectReadiness } = await import('../../src/index.ts');
  const options = await localOptions();
  const prepared = await prepareModel(options.model!.manifest.model, { directory: options.model!.directory });
  const readiness = await inspectReadiness(options.pythonExecutable!, prepared.model, { load: true });
  expect(prepared.integrity).toBe('matches-manifest');
  expect(readiness).toMatchObject({ files: 'present', integrity: 'not-verified', runtime: { status: 'load-ready', version: '0.22.0' } });
  expect(readiness.capabilities[0]?.maskMode).toBe('composite');
}, 600_000);

it('edits through a mask while preserving every black-mask source pixel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-masked-inference-'));
  const editor = createEditor(await localOptions());
  try {
    const sourceImage = join(directory, 'source.png'); const maskImage = join(directory, 'mask.png');
    await sharp({ create: { width: 256, height: 256, channels: 3, background: 'red' } }).png().toFile(sourceImage);
    const mask = Buffer.alloc(256 * 256);
    for (let y = 0; y < 256; y++) mask.fill(255, y * 256 + 128, (y + 1) * 256);
    await sharp(mask, { raw: { width: 256, height: 256, channels: 1 } }).toColourspace('b-w').png().toFile(maskImage);
    const original = await readFile(sourceImage); const originalMask = await readFile(maskImage);
    const result = await editor.edit({ instruction: 'Make the entire image solid blue.', sourceImage, maskImage, seed: 42 });
    expect(result.image.size).toEqual({ width: 256, height: 256 });
    const pixels = await sharp(result.image.path).ensureAlpha().raw().toBuffer();
    let changed = false;
    for (let i = 0; i < mask.length; i++) {
      const pixel = pixels.subarray(i * 4, i * 4 + 4);
      if (mask[i] === 0) expect([...pixel]).toEqual([255, 0, 0, 255]);
      else if (!pixel.equals(Buffer.from([255, 0, 0, 255]))) changed = true;
    }
    expect(changed).toBe(true);
    expect(await readFile(sourceImage)).toEqual(original);
    expect(await readFile(maskImage)).toEqual(originalMask);
    await editor.dispose();
    expect((await readdir(directory)).filter(name => name.startsWith('.picpatch-'))).toEqual([]);
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 1_800_000);
