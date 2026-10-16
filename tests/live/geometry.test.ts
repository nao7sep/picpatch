import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inputGeometry } from '../../src/images/geometry.ts';

it('matches the installed MFLUX conditioning geometry and leaves prepared sizes unchanged', async () => {
  const path = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  const config = JSON.parse(await readFile(path, 'utf8')) as { pythonExecutable: string };
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
  const { stdout } = await promisify(execFile)(config.pythonExecutable, ['-c', script, JSON.stringify(sizes)], { timeout: 30_000,
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  const expected = JSON.parse(stdout) as ([number, number] | null)[];
  sizes.forEach(([width, height], index) => {
    if (expected[index] === null) expect(() => inputGeometry(width!, height!, 1, 'klein-reference')).toThrow();
    else {
      const geometry = inputGeometry(width!, height!, 1, 'klein-reference');
      expect([geometry.preparedSize.width, geometry.preparedSize.height]).toEqual(expected[index]);
    }
  });
}, 45_000);
