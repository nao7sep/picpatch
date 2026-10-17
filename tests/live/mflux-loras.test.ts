import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks every installed family constructor and mapping, rejects ignored tensors, and composes unbaked adapters', async () => {
  const config = JSON.parse(await readFile(process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url)), 'utf8'));
  const script = `import importlib, inspect, tempfile
from types import SimpleNamespace
from pathlib import Path
import mlx.core as mx
import mlx.nn as nn
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.runtime import MODEL_DEFINITIONS
from picpatch_worker.backends.loras import MAPPINGS, lora_kwargs, validate_loaded_loras
from picpatch_worker.backends.errors import InvalidEditInput
from mflux.models.common.lora.mapping.lora_loader import LoRALoader
from mflux.models.flux2.weights.flux2_lora_mapping import Flux2LoRAMapping
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'adapter.safetensors'
    for variant, definition in MODEL_DEFINITIONS.items():
        adapter = create_adapter({'variant': variant, 'manifest': {'model': variant}})
        for operation in ('generate', 'edit'):
            if not adapter.capabilities['textToImage' if operation == 'generate' else 'instructionEditing']: continue
            _, pipeline, _ = adapter.import_pipeline(operation)
            inspect.signature(pipeline).bind_partial(model_path=directory, lora_paths=[str(path)], lora_scales=[-0.5], bake_lora=False)
        family = definition['family']
        package, module, name = MAPPINGS[family]
        target = next(item for item in getattr(importlib.import_module(f'mflux.models.{package}.weights.{module}'), name).get_mapping() if item.possible_up_patterns and item.possible_down_patterns)
        up = target.possible_up_patterns[0].replace('{block}', '0')
        down = target.possible_down_patterns[0].replace('{block}', '0')
        weights = {up: mx.ones((3, 1)), down: mx.ones((1, 2))}
        mx.save_safetensors(str(path), weights)
        config = {'directory': directory, 'loras': [{'path': path.name, 'scale': -0.5}, {'path': path.name, 'scale': 0}]}
        kwargs = lora_kwargs(config, family)
        assert kwargs == {'lora_paths': [str(path), str(path)], 'lora_scales': [-0.5, 0], 'bake_lora': False}
        mx.save_safetensors(str(path), {**weights, 'unsupported.weight': mx.ones((1,))})
        try: lora_kwargs(config, family)
        except InvalidEditInput: pass
        else: raise AssertionError(('ignored tensor', variant))
    class Transformer(nn.Module):
        def __init__(self): self.x_embedder = nn.Linear(2, 3, bias=False)
    weights = {'transformer.x_embedder.lora_A.weight': mx.ones((1, 2)), 'transformer.x_embedder.lora_B.weight': mx.ones((3, 1))}
    mx.save_safetensors(str(path), weights)
    second = Path(directory) / 'second.safetensors'; mx.save_safetensors(str(second), weights)
    model = Transformer(); x = mx.ones((1, 2)); before = model.x_embedder(x); mx.eval(before)
    LoRALoader.load_and_apply_lora(Flux2LoRAMapping.get_mapping(), model, [str(path), str(second)], [1.0, -0.5], bake_lora=False)
    assert bool(mx.allclose(model.x_embedder(x), before + 1.0))
    assert not isinstance(model.x_embedder, nn.Linear)
    validate_loaded_loras(SimpleNamespace(transformer=model))
    model.x_embedder.loras[0].lora_A = mx.ones((4, 1))
    try: validate_loaded_loras(SimpleNamespace(transformer=model))
    except InvalidEditInput: pass
    else: raise AssertionError('Invalid dimensions passed load validation')
print('verified')`;
  const result = await promisify(execFile)(config.pythonExecutable, ['-c', script], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url)), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, timeout: 60_000,
  });
  expect(result.stdout.trim().endsWith('verified')).toBe(true);
}, 60_000);
