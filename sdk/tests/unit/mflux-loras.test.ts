import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listModels, prepareModel, verifyModel } from 'picpatchsdk';
import { tensorFile } from '../helpers/native-assets.ts';
import { validateLocalModel } from '../../src/models/verification.ts';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-mflux-loras-'));
  for (const part of ['transformer', 'vae', 'text_encoder', 'tokenizer']) {
    await mkdir(join(directory, part));
    await writeFile(join(directory, part, part === 'tokenizer' ? 'tokenizer.json' : 'weights.safetensors'), 'fixture');
  }
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const shapes = { 'transformer.x_embedder.lora_A.weight': [1, 128], 'transformer.x_embedder.lora_B.weight': [3072, 1] };
it('prepares multiple local adapters without writes and retains explicit integrity checking', async () => {
  for (const name of ['one', 'two']) await tensorFile(join(directory, `${name}.safetensors`), shapes);
  const before = await readFile(join(directory, 'one.safetensors'));
  const prepared = await prepareModel('flux2-klein-4b', { directory, loras: [{ path: 'one.safetensors', scale: 0 }, { path: 'two.safetensors', scale: -1 }] });
  expect(prepared.model.loras).toEqual([{ path: 'one.safetensors', scale: 0 }, { path: 'two.safetensors', scale: -1 }]);
  expect(prepared.model.manifest.components.filter(item => !item.path.includes('/'))).toHaveLength(2);
  expect((await verifyModel(directory, prepared.model.manifest)).status).toBe('matches-manifest');
  expect(await readFile(join(directory, 'one.safetensors'))).toEqual(before);
  await writeFile(join(directory, 'two.safetensors'), 'changed');
  expect((await verifyModel(directory, prepared.model.manifest)).status).not.toBe('matches-manifest');
  expect(listModels().find(item => item.id === 'flux2-klein-4b')?.capabilities.loraFormats).toContain('mflux-lora-safetensors');
  for (const id of ['krea-2', 'krea-2-raw', 'boogu-image-turbo', 'ming-image-design']) {
    expect(listModels().find(item => item.id === id)?.capabilities.loraFormats).toBeUndefined();
  }
});
it.each([null, [], [{ path: '../outside.safetensors' }], [{ path: '/absolute.safetensors' }], [{ path: 'a.safetensors', scale: Infinity }], [{ path: 'a.gguf' }], [{ path: 'a.safetensors' }, { path: 'A.safetensors' }]])('rejects malformed selections before acquiring a base', async loras => {
  await expect(prepareModel('flux2-klein-4b-4bit', { directory: '/missing', loras: loras as never })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it.each(['missing-up', 'rank', 'dora', 'unknown', 'alias'])('rejects %s tensor structures', async kind => {
  const invalid: Record<string, number[]> = { ...shapes };
  if (kind === 'missing-up') delete invalid['transformer.x_embedder.lora_B.weight'];
  if (kind === 'rank') invalid['transformer.x_embedder.lora_B.weight'] = [3072, 2];
  if (kind === 'dora') invalid['transformer.x_embedder.dora_scale'] = [3072];
  if (kind === 'unknown') invalid['unknown.weight'] = [1];
  if (kind === 'alias') invalid['transformer.x_embedder.lora_up.weight'] = [3072, 1];
  await tensorFile(join(directory, 'adapter.safetensors'), invalid);
  await expect(prepareModel('flux2-klein-4b', { directory, loras: [{ path: 'adapter.safetensors' }] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('rechecks metadata after preparation callbacks and honors cancellation', async () => {
  await tensorFile(join(directory, 'adapter.safetensors'), shapes);
  await expect(prepareModel('flux2-klein-4b', { directory, loras: [{ path: 'adapter.safetensors' }] }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(prepareModel('flux2-klein-4b', { directory, loras: [{ path: 'adapter.safetensors' }] }, { onProgress: event => {
    if (event.stage === 'loras') writeFileSync(join(directory, 'adapter.safetensors'), 'invalid');
  } })).rejects.toMatchObject({ code: 'MODEL_COMPONENT_INVALID' });
});
it.each(['krea-2', 'krea-2-raw', 'boogu-image-turbo', 'ming-image-design', 'ideogram4-fp8'])('refuses LoRAs for %s, which takes none, before reading them', async id => {
  await tensorFile(join(directory, 'adapter.safetensors'), shapes);
  let read = false;
  await expect(prepareModel(id, { directory, loras: [{ path: 'adapter.safetensors' }] }, { onProgress: () => { read = true; } })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  expect(read).toBe(false);
  // A saved registration that names LoRAs for such a model is refused too, before any worker starts.
  const { model } = await prepareModel('flux2-klein-4b', { directory, loras: [{ path: 'adapter.safetensors' }] });
  expect(() => validateLocalModel({ ...model, variant: id })).toThrow('This model does not take LoRAs.');
});
