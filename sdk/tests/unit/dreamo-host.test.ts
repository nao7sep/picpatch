import { expect, it } from 'vitest';
import { modelCapabilities, modelDefinition } from '../../src/models/variants.ts';
import { validateEditRequest, validateGenerateRequest } from '../../src/validation.ts';
import { identifyEngine, runtimePaths } from '../../src/runtime/engine/identity.ts';
import { workerLaunch } from '../../src/backends/python/launch.ts';
import { validateLocalModel } from '../../src/models/verification.ts';

const capabilities = modelCapabilities('flux1-dreamo-v1.1');
const request = { model: capabilities.model, instruction: '{alice} stands beside {bob}', outputPath: '/tmp/out.png', references: [
  { id: 'alice', role: 'subject', conditioning: 'identity', images: ['/tmp/a.png'] },
  { id: 'bob', role: 'subject', conditioning: 'identity', images: ['/tmp/b.png'] },
] };
it('admits separately named subjects and refuses pooling, missing bindings, raw indices and source edits', () => {
  expect(validateEditRequest(request, capabilities).references).toHaveLength(2);
  for (const change of [
    { sourceImage: '/tmp/source.png' }, { instruction: '{alice} and [ref#2]' }, { instruction: '{alice} alone' },
    { references: [{ ...request.references[0], images: ['/tmp/a.png', '/tmp/b.png'] }] },
    { references: [{ ...request.references[0], conditioning: 'prompt' }] },
    { references: [{ ...request.references[0], className: 'person' }] },
  ]) expect(() => validateEditRequest({ ...request, ...change }, capabilities)).toThrow();
  expect(() => validateGenerateRequest({ model: capabilities.model, prompt: 'scene', outputPath: '/tmp/out.png' }, capabilities)).toThrow();
});
it('selects isolated engine identity and source entry without ambient path configuration', () => {
  expect(identifyEngine('manifest', 'lock', 'dreamo').id).not.toBe(identifyEngine('manifest', 'lock').id);
  expect(runtimePaths('dreamo').projectDirectory).toMatch(/runtimes[\\/]dreamo[\\/]$/);
  expect(() => runtimePaths('unknown' as never)).toThrow();
  const launch = workerLaunch('/tmp/python', '/tmp/install', 'dreamo');
  // Windows paths arrive JSON-escaped (\\); compare with one separator.
  const args = launch.args?.join(' ').replace(/\\+/g, '/');
  expect(args).toContain('picpatch_dreamo.__main__');
  expect(args).toContain('runtimes/common/src');
  expect(args).not.toContain('runtimes/mflux/src');
  expect(launch.env?.HF_HUB_OFFLINE).toBe('1');
});
it('requires preprocessing and fixed trained components, without accepting foreign quantization', () => {
  expect(modelDefinition('flux1-dreamo-v1.1').requiredFiles).toContain('preprocessing/BEN2_Base.pth');
  expect(() => validateLocalModel({ variant: 'flux1-dreamo-v1.1', directory: '/tmp/bundle', quantize: 4,
    manifest: { version: 1, model: 'dreamo', source: { repository: 'local', revision: 'a'.repeat(40) }, components: [{ path: 'weights.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] } })).toThrow(/quantization/);
});

it('fingerprints the complete DreamO base, adaptation and preprocessing bundle before accepting it', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { prepareModel } = await import('../../src/models/preparation.ts');
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-dreamo-'));
  try {
    const files = [...modelDefinition('flux1-dreamo-v1.1').requiredFiles!, ...['transformer', 'vae', 'text_encoder', 'text_encoder_2'].map(part => `base/${part}/model.safetensors`)];
    for (const path of files) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), path.endsWith('.json') ? '{}' : 'fixture'); }
    const result = await prepareModel('flux1-dreamo-v1.1', { directory });
    expect(result.model.manifest.components.find(component => component.path === 'preprocessing/BEN2_Base.pth')?.role).toBe('weights');
    await rm(join(directory, 'base/text_encoder_2/model.safetensors'));
    await expect(prepareModel('flux1-dreamo-v1.1', { directory })).rejects.toMatchObject({ code: 'MODEL_IO' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
