import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel } from '../../src/index.ts';
import { nativeRevision } from '../../src/backends/stable-diffusion-cpp/models.ts';
import { hiDreamShapes, tensorFile } from '../helpers/native-assets.ts';

// Protocol process double: verifies compilation/publication, not trained inference.
// The fake sd-cli is a shebang script, which Windows cannot start.
it.skipIf(process.platform === 'win32')('routes HiDream source and multiple references through ordered native image inputs and records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-hidream-cli-'));
  try {
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
    const sourceImage = join(directory, 'source.png'); const first = join(directory, 'first.png'); const second = join(directory, 'second.png');
    for (const path of [sourceImage, first, second]) await writeFile(path, png);
    await tensorFile(join(directory, 'model.safetensors'), hiDreamShapes);
    const executable = join(directory, 'sd-cli');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('stable-diffusion.cpp version fixture, commit ${nativeRevision}'); process.exit(0); }
const value = flag => args[args.indexOf(flag) + 1];
if (args.includes('--init-img') || args.includes('--vae') || args.includes('--strength') || !args.includes('--disable-image-metadata')) process.exit(10);
const refs = args.flatMap((arg, i) => arg === '--ref-image' ? [args[i + 1]] : []);
const prompt = fs.readFileSync(value('--prompt-file'), 'utf8');
if (refs.length) {
 if (refs.length !== 3 || refs.some(file => !fs.existsSync(file) || path.dirname(file) !== process.cwd())) process.exit(11);
 if (!prompt.startsWith('Image 1 is the source image to edit.\\nImages 2, 3 are subject references for group "subject".')) process.exit(12);
} else if (prompt !== 'A bowl.') process.exit(13);
if (value('--steps') !== '28' || value('--cfg-scale') !== '1' || value('--sampling-method') !== 'euler' || value('--scheduler') !== 'discrete') process.exit(14);
fs.writeFileSync(value('--output'), Buffer.from('${png.toString('base64')}', 'base64'));
`, { mode: 0o700 });
    const { model } = await prepareModel('hidream-o1-dev', { directory, checkpoint: 'model.safetensors' });
    const client = createImageClient({ model, nativeExecutable: executable, defaults: { size: { width: 32, height: 32 }, outputDirectory: directory } });
    try {
      const generated = await client.generate({ prompt: 'A bowl.', seed: 42 });
      if ('status' in generated) throw new Error(generated.code);
      expect(generated.seed).toBe(42);
      const edited = await client.edit({ instruction: 'Arrange these objects.', sourceImage, references: [{ id: 'subject', role: 'subject', images: [first, second] }], seed: 42, sidecar: {} });
      if ('status' in edited) throw new Error(edited.code);
      expect(edited.references[0]!.images).toEqual([first, second]);
      expect(edited.record.effectiveParameters).toMatchObject({ steps: 28, guidance: 1, sampler: 'euler', scheduler: 'discrete' });
      const sidecar = await readFile(edited.sidecar!.path, 'utf8');
      expect(sidecar).not.toContain(directory);
      expect(sidecar).toContain('hidream-o1-dev');
      expect((await sharp(edited.image.path).metadata()).width).toBe(32);
    } finally { await client.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
