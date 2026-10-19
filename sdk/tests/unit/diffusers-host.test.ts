import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { modelCapabilities, modelDefinition, modelRuntime } from '../../src/models/variants.ts';
import { validateGenerateRequest, validateEditRequest } from '../../src/validation.ts';
import { identifyEngine } from '../../src/runtime/engine/identity.ts';
import { workerLaunch } from '../../src/backends/python/launch.ts';
import { prepareModel } from '../../src/models/preparation.ts';
import { validateLocalModel } from '../../src/models/verification.ts';

it('routes GLM generation and ordered editing through its isolated Diffusers engine', () => {
  const capabilities = modelCapabilities('glm-image');
  expect(validateGenerateRequest({ model: 'glm-image', prompt: 'A sign', outputPath: '/tmp/out.png' }, capabilities)).toBeDefined();
  expect(validateEditRequest({ model: 'glm-image', instruction: 'Change the sign', sourceImage: '/tmp/source.png', outputPath: '/tmp/out.png' }, capabilities)).toBeDefined();
  expect(modelRuntime('glm-image')).toBe('diffusers');
  expect(identifyEngine('manifest', 'lock', 'diffusers').id).not.toBe(identifyEngine('manifest', 'lock', 'dreamo').id);
  expect(identifyEngine('manifest', 'lock').dependencies).toBe('inference');
  expect(workerLaunch('/tmp/python', undefined, 'diffusers').args?.join(' ')).toContain('picpatch_diffusers.__main__');
});

it.each(['glm-image', 'flux2-dev'])('fingerprints %s configuration and components, rejecting incomplete bundles and unsupported modifiers', async variant => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-glm-'));
  try {
    const definition = modelDefinition(variant);
    const files = [...definition.requiredFiles!, ...definition.requiredDirectories.filter(part => !['tokenizer', 'processor', 'scheduler'].includes(part)).map(part => `${part}/model.safetensors`)];
    for (const file of files) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), file.endsWith('.json') ? '{}' : 'fixture');
    }
    const result = await prepareModel(variant, { directory });
    expect(result.model.manifest.components.find(component => component.path === 'model_index.json')).toMatchObject({ role: 'configuration' });
    expect(() => validateLocalModel({ ...result.model, quantize: 4 })).toThrow(/quantization/);
    await expect(prepareModel(variant, { directory, loras: [] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await rm(join(directory, 'text_encoder/model.safetensors'));
    await expect(prepareModel(variant, { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
