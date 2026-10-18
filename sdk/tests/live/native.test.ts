import { nativeCheckpoint } from '../helpers/native-assets.ts';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, prepareModel, inspectReadiness } from '../../src/index.ts';
import { nativeRevision } from '../../src/backends/stable-diffusion-cpp/models.ts';

async function fixture(revision = nativeRevision) {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-native-pipes-'));
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
  const executable = join(directory, 'sd-cli');
  await nativeCheckpoint(join(directory, 'weights.safetensors'), 'sdxl');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('stable-diffusion.cpp version fixture, commit ${revision}'); process.exit(0); }
const value = name => args[args.indexOf(name) + 1];
const prompt = fs.readFileSync(value('--prompt-file'), 'utf8');
if (args.includes(prompt) || !args.includes('--disable-image-metadata') || value('--batch-count') !== '1') process.exit(5);
if (args.includes('--init-img')) {
  const path = require('node:path');
  if (path.dirname(value('--init-img')) !== process.cwd() || !fs.existsSync(value('--init-img'))) process.exit(6);
  if (prompt.startsWith('variation:') && (args.includes('--mask') || value('--strength') !== prompt.split(':')[1])) process.exit(7);
} else if (args.includes('--strength')) process.exit(8);
if (prompt === 'hold') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
else if (prompt === 'fail') { console.error('private library detail'); process.exit(2); }
else if (prompt === 'malformed') fs.writeFileSync(value('--output'), 'not an image');
else { fs.writeFileSync(value('--output'), Buffer.from('${png.toString('base64')}', 'base64')); }
`, { mode: 0o700 });
  return { directory, executable, png };
}

it('runs native generation and masked editing through public preparation, pipes and safe publication', async () => {
  const { directory, executable, png } = await fixture();
  try {
    for (const variant of ['sdxl', 'sdxl-inpaint']) {
      await nativeCheckpoint(join(directory, 'weights.safetensors'), variant);
      const { model } = await prepareModel(variant, { directory, checkpoint: 'weights.safetensors' });
      expect(await inspectReadiness(executable, model)).toMatchObject({ runtime: { status: 'executable-ready', version: nativeRevision } });
      await expect(inspectReadiness(executable, model, { load: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      const editor = createEditor({ model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory } });
      try {
        await writeFile(join(directory, 'source.png'), png);
        await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).toColourspace('b-w').png().toFile(join(directory, 'mask.png'));
        const result = variant === 'sdxl' ? await editor.generate({ prompt: 'Blue', parameters: { steps: 3 } }) : await editor.edit({ instruction: 'Blue', sourceImage: join(directory, 'source.png'), maskImage: join(directory, 'mask.png') });
        if ('status' in result) throw new Error(result.code);
        expect(await readFile(result.image.path)).toEqual(png);
        expect(result.effectiveParameters).toMatchObject({ steps: variant === 'sdxl' ? 3 : 20, guidance: 7, sampler: 'euler_a', scheduler: 'discrete' });
        expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
        if (variant === 'sdxl') {
          await expect(editor.generate({ prompt: 'fail' })).rejects.toMatchObject({ code: 'WORKER_EXITED', details: { diagnostic: { phase: 'worker', exitCode: 2, causes: [{ kind: 'ProcessExit' }] } } });
          await expect(editor.generate({ prompt: 'malformed' })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
          await expect(editor.generate({ prompt: '<lora:unknown:1>' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
          await expect(editor.generate({ prompt: 'Blue', outputPath: result.image.path })).resolves.toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' });
          await editor.generate({ prompt: 'Blue' });
        }
      } finally { await editor.dispose(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rejects unrecognized native versions without opening images', async () => {
  const { directory, executable } = await fixture('deadbeef');
  const { model } = await prepareModel('sdxl', { directory, checkpoint: 'weights.safetensors' });
  const editor = createEditor({ model, nativeExecutable: executable });
  try { await expect(editor.generate({ prompt: 'Blue', outputPath: join(directory, 'out.png') })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' }); }
  finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('times out and disposes native children that ignore graceful termination before cleanup', async () => {
  const { directory, executable } = await fixture();
  const { model } = await prepareModel('sdxl', { directory, checkpoint: 'weights.safetensors' });
  const editor = createEditor({ model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory }, timeouts: { generateMs: 100, cancellationMs: 20, terminationMs: 1000 } });
  try {
    await expect(editor.generate({ prompt: 'hold' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const pending = editor.generate({ prompt: 'hold' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await editor.dispose(); await rejected;
    expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it.each(['sd15', 'sdxl'])('runs repeated %s source variations with default/session/request strength and settled cancellation', async variant => {
  const { directory, executable, png } = await fixture();
  await nativeCheckpoint(join(directory, 'weights.safetensors'), variant);
  const { model } = await prepareModel(variant, { directory, checkpoint: 'weights.safetensors' });
  const editor = createEditor({ model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory } });
  const sourceImage = join(directory, 'source.png');
  await sharp({ create: { width: 29, height: 19, channels: 3, background: 'red' } }).png().toFile(sourceImage);
  const original = await readFile(sourceImage);
  try {
    const first = await editor.edit({ instruction: 'variation:0.75', sourceImage });
    if ('status' in first) throw new Error(first.code);
    expect(first.effectiveParameters.strength).toBe(0.75);
    expect(first.inputGeometry?.[0]).toMatchObject({ path: sourceImage, preparedSize: { width: 29, height: 19 } });
    for (const strength of [0, 0.5, 1]) {
      const result = await editor.edit({ instruction: `variation:${strength}`, sourceImage: first.image.path, parameters: { strength } });
      if ('status' in result) throw new Error(result.code);
      expect(result.effectiveParameters.strength).toBe(strength);
      expect(await readFile(result.image.path)).toEqual(png);
    }
    const controller = new AbortController();
    await expect(editor.edit({ instruction: 'hold', sourceImage }, { signal: controller.signal, onEvent: event => {
      if (event.stage === 'editing') controller.abort();
    } })).rejects.toMatchObject({ code: 'CANCELLED' });
    await editor.edit({ instruction: 'variation:0.75', sourceImage });
    const generated = await editor.generate({ prompt: 'Blue' });
    if ('status' in generated) throw new Error(generated.code);
    expect(generated.effectiveParameters).not.toHaveProperty('strength');
    expect(await readFile(sourceImage)).toEqual(original);
    expect(await readFile(first.image.path)).toEqual(png);
    expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
    const session = createEditor({ model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory, parameters: { strength: 0.4 } } });
    try {
      expect(await session.edit({ instruction: 'variation:0.4', sourceImage })).toMatchObject({ effectiveParameters: { strength: 0.4 } });
      expect(await session.edit({ instruction: 'variation:0.2', sourceImage, parameters: { strength: 0.2 } })).toMatchObject({ effectiveParameters: { strength: 0.2 } });
      await expect(session.generate({ prompt: 'Blue' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    } finally { await session.dispose(); }
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
});
