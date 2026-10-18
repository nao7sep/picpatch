import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks parameter mappings, defaults and scheduler construction against every installed pipeline without weights', async () => {
  const configPath = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  const { pythonExecutable } = JSON.parse(await readFile(configPath, 'utf8')) as { pythonExecutable: string };
  const worker = fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url));
  const script = `import inspect
import mlx.core as mx
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.runtime import MODEL_DEFINITIONS
from mflux.models.common.config import Config, ModelConfig
names = {'steps': 'num_inference_steps', 'guidance': 'guidance', 'negativePrompt': 'negative_prompt', 'scheduler': 'scheduler', 'strength': 'strength'}
for variant, definition in MODEL_DEFINITIONS.items():
    adapter = create_adapter({'variant': variant, 'manifest': {'model': variant}})
    caps = adapter.capabilities
    for operation in ('generate', 'edit'):
        if not caps['textToImage' if operation == 'generate' else 'instructionEditing']:
            continue
        model_config, pipeline, _ = adapter.import_pipeline(operation)
        signature = inspect.signature(pipeline.generate_image)
        kwargs, effective = adapter.sampling({}, operation)
        for key, descriptor in caps['parameters'].items():
            if key == 'strength' and operation != 'edit': continue
            assert names[key] in signature.parameters, (variant, operation, key)
            if key in ('steps', 'guidance', 'strength'):
                actual = kwargs.get(names[key], signature.parameters[names[key]].default)
                assert actual == descriptor['default'], (variant, key, actual)
        # Qwen's shifted linear schedule is non-finite at one step; its advertised minimum must exclude it.
        for scheduler in caps['parameters']['scheduler']['values']:
            for steps in (int(caps['parameters']['steps']['minimum']), effective['steps']):
                config = Config(model_config=model_config, num_inference_steps=steps, width=256, height=256, scheduler=scheduler)
                sigmas = config.scheduler.sigmas
                mx.eval(sigmas)
                assert bool(mx.all(mx.isfinite(sigmas))), (variant, scheduler, steps)
        supplied = {'steps': 3, 'scheduler': effective['scheduler']}
        if 'guidance' in caps['parameters']: supplied['guidance'] = 2.0
        if 'negativePrompt' in caps['parameters']: supplied['negativePrompt'] = ''
        if 'strength' in caps['parameters'] and operation == 'edit': supplied['strength'] = 0.5
        mapped, resolved = adapter.sampling({'parameters': supplied}, operation)
        assert all(mapped[names[key]] == value for key, value in supplied.items())
        signature.bind_partial(None, seed=0, prompt='Blue', **mapped)
config = Config(model_config=ModelConfig.qwen_image_21(), num_inference_steps=40, width=64, height=32, image_path='/source.png', image_strength=0.5, scheduler='linear')
assert config.init_time_step == 20
assert len(list(config.time_steps)) == 20
print('verified')`;
  const result = await promisify(execFile)(pythonExecutable, ['-c', script], {
    env: { ...process.env, PYTHONPATH: worker, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, timeout: 60_000,
  });
  expect(result.stdout.trim()).toBe('verified');
}, 60_000);
