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
  await writeFile(join(directory, 'weights.safetensors'), 'synthetic; never real weights');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('stable-diffusion.cpp version fixture, commit ${revision}'); process.exit(0); }
const value = name => args[args.indexOf(name) + 1];
const prompt = fs.readFileSync(value('--prompt-file'), 'utf8');
if (args.includes(prompt) || !args.includes('--disable-image-metadata') || value('--batch-count') !== '1') process.exit(5);
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
      const { model } = await prepareModel(variant, { directory, checkpoint: 'weights.safetensors' });
      expect(await inspectReadiness(executable, model)).toMatchObject({ runtime: { status: 'executable-ready', version: nativeRevision } });
      await expect(inspectReadiness(executable, model, { load: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      const editor = createEditor({ model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory } });
      try {
        await writeFile(join(directory, 'source.png'), png);
        await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).toColourspace('b-w').png().toFile(join(directory, 'mask.png'));
        const result = variant === 'sdxl' ? await editor.generate({ prompt: 'Blue', parameters: { steps: 3 } }) : await editor.edit({ instruction: 'Blue', sourceImage: join(directory, 'source.png'), maskImage: join(directory, 'mask.png') });
        expect(await readFile(result.image.path)).toEqual(png);
        expect(result.effectiveParameters).toMatchObject({ steps: variant === 'sdxl' ? 3 : 20, guidance: 7, sampler: 'euler_a', scheduler: 'discrete' });
        expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
        if (variant === 'sdxl') {
          await expect(editor.generate({ prompt: 'fail' })).rejects.toMatchObject({ code: 'RUNTIME_FAILURE' });
          await expect(editor.generate({ prompt: 'malformed' })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
          await expect(editor.generate({ prompt: '<lora:unknown:1>' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
          await expect(editor.generate({ prompt: 'Blue', outputPath: result.image.path })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
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
