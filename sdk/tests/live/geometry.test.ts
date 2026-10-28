import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { inputGeometry } from '../../src/images/geometry.ts';
import { inferenceConfig } from '../helpers/live-cache.ts';

it('matches the installed MFLUX conditioning geometry and leaves prepared sizes unchanged', async () => {
    const config = await inferenceConfig() as { pythonExecutable: string };
  const sizes = [[16, 16], [33, 47], [1024, 1024], [2048, 1024], [1025, 1025], [4096, 64], [3001, 1999], [15, 32], [100000, 16]];
  const script = `import json, sys
from mflux.models.flux2.variants.edit.flux2_klein_edit_helpers import _Flux2KleinEditHelpers as Helper
results = []
for w, h in json.loads(sys.argv[1]):
    try:
        size = Helper.reference_dims(w, h)
        results.append(list(size))
        assert Helper.reference_dims(*size) == size
    except ValueError:
        results.append(None)
print(json.dumps(results))`;
  const { stdout } = await promisify(execFile)(config.pythonExecutable, ['-c', script, JSON.stringify(sizes)], { env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  const expected = JSON.parse(stdout) as ([number, number] | null)[];
  sizes.forEach(([width, height], index) => {
    if (expected[index] === null) expect(() => inputGeometry(width!, height!, 1, 'klein-reference')).toThrow();
    else {
      const geometry = inputGeometry(width!, height!, 1, 'klein-reference');
      expect([geometry.preparedSize.width, geometry.preparedSize.height]).toEqual(expected[index]);
    }
  });
});

it('uses installed Kontext resizing and distinct reference positions without loading weights', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
    const config = await inferenceConfig() as { pythonExecutable: string };
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-kontext-'));
  try {
    const script = `from pathlib import Path
from PIL import Image
import mlx.core as mx
from mflux.models.flux.variants.kontext.kontext_util import KontextUtil
import sys
source = Path(sys.argv[1]) / 'source.png'
Image.new('RGB', (49, 33), (255, 0, 0)).save(source)
class Encoder:
    def encode(self, image):
        assert image.shape == (1, 3, 16, 32)
        return mx.ones((1, 16, 2, 4))
latent, ids = KontextUtil.create_image_conditioning_latents(Encoder(), 16, 32, str(source))
mx.eval(latent, ids)
assert latent.shape == (1, 2, 64)
assert bool(mx.all(latent == 1))
assert ids.tolist() == [[[1.0, 0.0, 0.0], [1.0, 0.0, 1.0]]]
mx.synchronize()
mx.clear_cache()`;
    await promisify(execFile)(config.pythonExecutable, ['-c', script, directory], { env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
