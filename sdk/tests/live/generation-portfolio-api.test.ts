import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { inferenceConfig } from '../helpers/live-cache.ts';

// This checks installed API compatibility, not model weights or image quality.
it('matches the installed Krea 2, Boogu and Ming APIs without loading weights', async () => {
  const config = await inferenceConfig();
  await promisify(execFile)(config.pythonExecutable, ['-c', `
import inspect
import tempfile
from pathlib import Path
from unittest.mock import patch
from mflux.models.common.weights.loading.weight_loader import WeightLoader
from picpatch_worker.backends import create_adapter
from mflux.models.krea2.weights.krea2_weight_definition import Krea2WeightDefinition
from mflux.models.boogu.weights.boogu_weight_definition import BooguWeightDefinition
from mflux.models.ming_image.weights.ming_image_weight_definition import MingImageWeightDefinition

for variant in ('krea-2', 'krea-2-raw', 'boogu-image-turbo', 'ming-image-design'):
    adapter = create_adapter({'variant': variant, 'manifest': {'model': 'fixture'}})
    model_config, pipeline, mx = adapter.import_pipeline('generate')
    assert model_config is not None
    init = inspect.signature(pipeline.__init__).parameters
    assert {'model_config', 'model_path', 'quantize'} <= init.keys()
    call = inspect.signature(pipeline.generate_image).parameters
    assert {'seed', 'prompt', 'width', 'height', 'num_inference_steps'} <= call.keys()
    source = inspect.getsource(pipeline.generate_image)
    for boundary in ('ctx.before_loop(', 'ctx.in_loop(', 'ctx.after_loop('):
        assert boundary in source
    if variant.startswith('krea'):
        assert call['num_inference_steps'].default == 8
        assert call['guidance'].default == 1
        assert pipeline._resolve_scheduler(None) == 'er_sde'
        assert pipeline._resolve_scheduler('euler') == 'euler'
        assert pipeline._resolve_scheduler('er_sde') == 'er_sde'
    elif variant == 'ming-image-design':
        assert call['num_inference_steps'].default == 12
        assert call['guidance'].default == 1
        assert 'negative_prompt' not in call and 'scheduler' not in call
        assert 'lora_paths' not in init
    else:
        assert call['num_inference_steps'].default == 4
        assert 'guidance' not in call and 'scheduler' not in call
        assert 'lora_paths' not in init

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / 'transformer').mkdir()
    selected = Krea2WeightDefinition._select_transformer_variant(root)
    assert selected.hf_subdir == 'transformer'
    (root / 'turbo.safetensors').write_bytes(b'fixture')
    assert Krea2WeightDefinition._select_transformer_variant(root).hf_subdir == ''
assert {component.hf_subdir for component in BooguWeightDefinition.get_components()} == {'vae', 'transformer', 'mllm'}
assert BooguWeightDefinition.get_tokenizers()[0].hf_subdir == 'mllm'
assert {component.hf_subdir for component in MingImageWeightDefinition.get_components()} == {'vae', 'transformer', 'mllm', 'connector', 'mlp'}
assert MingImageWeightDefinition.get_tokenizers()[0].hf_subdir == 'mllm'
# Real local root resolution/component selection, substituting tensor reads.
for definition, expected in (
    (Krea2WeightDefinition, {'vae', 'transformer', 'text_encoder'}),
    (BooguWeightDefinition, {'vae', 'transformer', 'mllm'}),
    (MingImageWeightDefinition, {'vae', 'transformer', 'mllm', 'connector', 'mlp'}),
):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for part in expected:
            (root / part).mkdir()
        seen = set()
        def read_component(root_path, component, cache, save_subdir):
            assert root_path.resolve() == root.resolve()
            selected = component.variant_selector(root_path) if component.variant_selector else component
            seen.add(selected.hf_subdir)
            return {}, None, None
        with patch.object(WeightLoader, '_load_component', side_effect=read_component):
            WeightLoader.load(weight_definition=definition, model_path=directory)
        assert seen == expected

`], { timeout: 30_000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url)), fileURLToPath(new URL('../../runtimes/common/src', import.meta.url))].join(':'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
}, 60_000);
