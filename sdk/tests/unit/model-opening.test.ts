import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openModel, inspectModels, prepareImageClient, readModelRegistration, validateModelRegistration, verifyModel } from '../../src/index.ts';
let directory: string;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/registrations/${name}.json`, import.meta.url));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-opening-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('opens a persisted registration using presence alone while explicit verification detects wrong content', async () => {
  const read = await readModelRegistration(fixture('current')); if (read.status === 'refused') throw new Error(read.code); const registration = read.registration;
  registration.model.directory = directory;
  await writeFile(join(directory, 'weights.safetensors'), 'test');
  expect(await openModel(registration)).toMatchObject({ status: 'completed', integrity: 'presence-only', compatibility: 'unknown' });
  expect(await verifyModel(directory, registration.model.manifest)).toMatchObject({ status: 'invalid', components: [{ status: 'digest-mismatch', code: 'MODEL_COMPONENT_DIGEST_MISMATCH', effect: 'none', message: expect.any(String) }] });
  await writeFile(join(directory, 'weights.safetensors'), 'wrong length');
  expect(await openModel(registration)).toMatchObject({ status: 'refused', code: 'MODEL_INCOMPLETE', details: { issues: [{ code: 'MODEL_FILE_SIZE_MISMATCH', effect: 'none' }] } });
  expect(validateModelRegistration(JSON.parse(JSON.stringify(registration)))).toEqual({ status: 'completed', registration });
});
it('preserves unsupported registrations and refuses them before looking at model files', async () => {
  const path = fixture('newer'); const original = await readFile(path);
  expect(await readModelRegistration(path)).toMatchObject({ status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED', subject: path, details: { version: 2 } });
  expect(await readFile(path)).toEqual(original);
});
it('reads a registration file by its header alone and never reads the writer', async () => {
  const current = JSON.parse(await readFile(fixture('current'), 'utf8'));
  const { format, writer: _writer, ...content } = current;
  const path = join(directory, 'registration.json');
  for (const value of [{ ...current, format: { ...format, owner: 'zipkit' } }, { ...current, format: { ...format, kind: 'profile' } }, content, { ...content, version: 1 }, { ...current, format: { ...format, version: 0 } }]) {
    await writeFile(path, JSON.stringify(value));
    await expect(readModelRegistration(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST', subject: path });
  }
  for (const writer of [undefined, 7, { name: 'someone else' }]) {
    await writeFile(path, JSON.stringify({ format, ...(writer === undefined ? {} : { writer }), ...content }));
    expect(await readModelRegistration(path)).toEqual({ status: 'completed', registration: content });
  }
});
it('inventories missing managed bundles without creating directories and honors roots', async () => {
  const result = await inspectModels({ profile: { modelsDirectory: join(directory, 'profile') }, modelsDirectory: join(directory, 'explicit') });
  expect(result.models.length).toBeGreaterThan(0);
  expect(result.models.every(item => item.status === 'missing' && item.directory.startsWith(join(directory, 'explicit')))).toBe(true);
  await expect(inspectModels({ modelsDirectory: 'relative' })).rejects.toMatchObject({ kind: 'invalid' });
  await expect(inspectModels({}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
});

it('round-trips persisted native split encoder roles without dropping or redirecting a component', async () => {
  const path = fixture('native-split-encoders');
  const bytes = await readFile(path);
  const { format, writer, ...expected } = JSON.parse(bytes.toString());
  const result = await readModelRegistration(path);
  if (result.status === 'refused') throw new Error(result.code);
  expect(result.registration).toEqual(expected);
  expect(result.registration.model).toMatchObject({ checkpoint: 'sd35-large.safetensors', clipL: 'clip-l.safetensors', clipG: 'clip-g.safetensors', t5: 't5.gguf', vae: 'vae.safetensors' });
  const saved = join(directory, 'registration.json');
  await writeFile(saved, JSON.stringify({ format, writer, ...result.registration }));
  const reread = await readModelRegistration(saved);
  expect(reread).toEqual(result);
  expect(await readFile(path)).toEqual(bytes);
  const incomplete = structuredClone(expected);
  incomplete.model.manifest.components = incomplete.model.manifest.components.filter((component: { path: string }) => component.path !== incomplete.model.t5);
  expect(() => validateModelRegistration(incomplete)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});

it('prepares a run from a model id, its registration and the profile, refusing and failing with its own codes', async () => {
  const read = await readModelRegistration(fixture('current')); if (read.status === 'refused') throw new Error(read.code);
  const registration = { ...read.registration, model: { ...read.registration.model, directory } };
  const profile = { engineDirectory: join(directory, 'engine') };
  expect(await prepareImageClient('flux2-klein-4b', { profile, registration })).toMatchObject({ status: 'refused', code: 'MODEL_INCOMPLETE' });
  await writeFile(join(directory, 'weights.safetensors'), 'test');
  expect(await prepareImageClient('flux2-klein-4b', { profile, registration })).toMatchObject({ status: 'completed', options: { model: registration.model, profile }, capabilities: { maskMode: expect.any(String) } });
  expect(await prepareImageClient('flux2-klein-4b-4bit', { profile: { ...profile, modelsDirectory: directory } })).toMatchObject({ status: 'refused', code: 'MODEL_INCOMPLETE' });
  const native = await readModelRegistration(fixture('native-split-encoders')); if (native.status === 'refused') throw new Error(native.code);
  native.registration.model.directory = directory;
  for (const component of native.registration.model.manifest.components) { await writeFile(join(directory, component.path), ''); await truncate(join(directory, component.path), component.bytes); }
  // No native engine is installed under this engine folder.
  await expect(prepareImageClient('sd35-large', { profile, registration: native.registration })).rejects.toMatchObject({ code: process.platform === 'darwin' || process.platform === 'win32' ? 'ENGINE_MISSING' : 'UNSUPPORTED_CAPABILITY' });
  await expect(prepareImageClient('unknown-model', { profile })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(prepareImageClient('flux2-klein-4b', { profile, signal: AbortSignal.abort() } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
