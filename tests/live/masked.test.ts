import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';

it('composites black, white and soft masks with exact sRGB and alpha channel endpoints', async () => {
  const configPath = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { pythonExecutable: string };
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-mask-pixels-'));
  try {
    const source = Buffer.from([11, 22, 33, 0, 100, 50, 25, 128, 10, 20, 30, 255]);
    const generated = Buffer.from([200, 100, 250, 255, 200, 100, 250, 255, 200, 100, 250, 255]);
    for (const [name, bytes] of [['source', source], ['generated', generated]] as const) {
      await sharp(bytes, { raw: { width: 3, height: 1, channels: 4 } }).png().toFile(join(directory, `${name}.png`));
    }
    const script = `from PIL import Image
from pathlib import Path
from picpatch_worker.backends.klein import composite_mask, InvalidEditInput
import sys
root = Path(sys.argv[1])
request = {'sourceImage': str(root / 'source.png'), 'maskImage': str(root / 'mask.png')}
with Image.open(root / 'generated.png') as generated:
    composite_mask(generated, request).save(root / 'out.png')
    try:
        composite_mask(Image.new('RGBA', (1, 1)), request)
    except InvalidEditInput:
        pass
    else:
        raise AssertionError('Mismatched generation must be rejected')`;
    for (const mask of [[0, 0, 0], [255, 255, 255], [0, 128, 255]]) {
      await sharp(Buffer.from(mask), { raw: { width: 3, height: 1, channels: 1 } }).toColourspace('b-w').png().toFile(join(directory, 'mask.png'));
      await promisify(execFile)(config.pythonExecutable, ['-c', script, directory], { timeout: 30_000,
        env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../runtimes/mflux/src/', import.meta.url)) } });
      const output = await sharp(join(directory, 'out.png')).ensureAlpha().raw().toBuffer();
      const expected = Buffer.from(source.map((value, index) => Math.round((value * (255 - mask[Math.floor(index / 4)]!) + generated[index]! * mask[Math.floor(index / 4)]!) / 255)));
      expect(output).toEqual(expected);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);
