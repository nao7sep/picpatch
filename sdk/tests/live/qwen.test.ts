import { fixtureEditor } from '../helpers/editor.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createImageClient } from '../../src/index.ts';
import { testPython } from '../helpers/python.ts';

it('rejects Qwen total-image and geometry violations over worker pipes before image I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-qwen-admission-'));
  const editor = fixtureEditor({ pythonExecutable: testPython, model: {
    variant: 'qwen-image-2.1', directory, manifest: { version: 1, model: 'qwen', source: { repository: 'fixture', revision: 'a'.repeat(40) },
      components: [{ path: 'missing.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] },
  } });
  try {
    const request = { instruction: 'Use blue.', sourceImage: join(directory, 'missing.png'), outputPath: join(directory, 'out.png') };
    await expect(editor.edit({ ...request, references: [{ id: 'r', role: 'object', images: [join(directory, 'r.png'), ...Array.from({ length: 9 }, (_, i) => join(directory, `${i}.png`))] }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(editor.edit({ ...request, size: { width: 16, height: 32 } })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await readdir(directory)).toEqual([]);
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('binds Qwen adapter calls to installed APIs and preserves synthetic RGBA output without weights', async () => {
  const path = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  const config = JSON.parse(await readFile(path, 'utf8')) as { pythonExecutable: string };
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-qwen-api-'));
  const worker = fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url));
  try {
    const script = `import inspect, sys
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch
import mlx.core as mx
from PIL import Image
from picpatch_worker.backends import create_adapter
from mflux.utils.image_util import ImageUtil
from mflux.models.qwen21.latent_creator.qwen_image21_latent_creator import QwenImage21LatentCreator as Geometry
from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
from mflux.models.common.config import ModelConfig
root = Path(sys.argv[1])
source = root / 'source.png'
Image.new('RGB', (49, 33), 'red').save(source)
config, vw, vh, w, h = QwenImageEdit._compute_dimensions(SimpleNamespace(model_config=ModelConfig.qwen_image_edit_2511()), [str(source)], 20, 32, 64, 4.0, None, 'linear')
assert (config.width, config.height, w, h) == (64, 32, 64, 32)
assert vw % 32 == vh % 32 == 0
Geometry.validate(4096, 4096, 40, 10)
for args in [(16, 32, 40, 1), (32, 32, 40, 11)]:
    try: Geometry.validate(*args)
    except ValueError: pass
    else: raise AssertionError('Invalid geometry admitted')
for variant in ('qwen-image', 'qwen-image-edit-2511', 'qwen-image-2.1'):
    adapter = create_adapter({'variant': variant, 'directory': str(root), 'manifest': {'model': variant, 'source': {'revision': 'a'*40}}})
    operation = 'edit' if adapter.capabilities['instructionEditing'] else 'generate'
    model_config, actual, _ = adapter.import_pipeline(operation)
    actual_signature = inspect.signature(actual.generate_image)
    image = ImageUtil.to_pil(mx.zeros((1, 4, 1, 32, 64)))
    assert image.mode == 'RGBA' and image.getpixel((0, 0)) == (128, 128, 128, 128)
    class Pipeline:
        callbacks = SimpleNamespace(register=lambda observer: None)
        def __init__(self, **kwargs):
            inspect.signature(actual).bind(**kwargs)
        def generate_image(self, **kwargs):
            actual_signature.bind(None, **kwargs)
            if kwargs.get('mask_image'):
                assert (kwargs['width'], kwargs['height']) == (64, 32)
            return SimpleNamespace(image=image)
    output = root / (variant + '.png')
    request = {'model': variant, 'seed': 0, 'size': {'width': 64, 'height': 32}, 'outputPath': str(output)}
    with patch.object(adapter, 'import_pipeline', return_value=(model_config, Pipeline, mx)):
        if operation == 'edit':
            adapter.edit({**request, 'instruction': 'Use blue.', 'sourceImage': str(source)}, Event(), lambda _: None)
        else:
            adapter.generate({**request, 'prompt': 'A bowl.'}, Event(), lambda _: None)
    with Image.open(output) as saved:
        assert saved.mode == 'RGBA' and saved.getpixel((0, 0)) == (128, 128, 128, 128)
        assert saved.info == {}
from mflux.models.qwen21.variants.edit.qwen_image_21_edit import QwenImage21Edit
from mflux.models.qwen21.model.qwen21_text_encoder.grounding import QwenImage21Grounding
source = root / 'aligned.png'
mask = root / 'mask.png'
Image.new('RGBA', (64, 32), (17, 81, 143, 63)).save(source)
m = Image.new('L', (64, 32), 255)
m.paste(0, (0, 0, 32, 32))
m.putpixel((32, 0), 128)
m.save(mask)
resolved = QwenImage21Edit._resolve_mask(None, str(mask), None, Image.open(source), 64, 32)
assert resolved.getpixel((0, 0)) == 0 and resolved.getpixel((32, 0)) == 128
latent = QwenImage21Grounding.to_latent_mask(resolved, 2, 4)
assert latent.min() == 0 and latent.max() == 1
output = root / 'masked.png'
with patch.object(adapter, 'import_pipeline', return_value=(model_config, Pipeline, mx)):
    adapter.edit({**{key: value for key, value in request.items() if key != 'size'}, 'instruction': 'Use blue.', 'sourceImage': str(source), 'maskImage': str(mask), 'outputPath': str(output)}, Event(), lambda _: None)
with Image.open(output) as saved:
    assert saved.getpixel((0, 0)) == (17, 81, 143, 63)
    assert saved.getpixel((32, 0)) == (128, 128, 128, 128)
assert sorted(p.suffix for p in root.iterdir()) == ['.png'] * 7
mx.synchronize()
mx.clear_cache()`;
    await promisify(execFile)(config.pythonExecutable, ['-c', script, directory], { timeout: 30_000,
      env: { ...process.env, PYTHONPATH: [worker, fileURLToPath(new URL('../../runtimes/common/src', import.meta.url))].join(':'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);
