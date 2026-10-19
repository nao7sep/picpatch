import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openModel, inspectModels, readModelRegistration, validateModelRegistration, verifyModel } from '../../src/index.ts';
let directory: string;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/registrations/${name}.json`, import.meta.url));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-opening-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('opens a persisted registration using presence alone while explicit verification detects wrong content', async () => {
  const read = await readModelRegistration(fixture('current')); if (read.status === 'refused') throw new Error(read.code); const registration = read.registration;
  registration.model.directory = directory;
  await writeFile(join(directory, 'weights.safetensors'), 'test');
  expect(await openModel(registration)).toMatchObject({ status: 'ready', integrity: 'presence-only', compatibility: 'unknown', version: 1 });
  expect(await verifyModel(directory, registration.model.manifest)).toMatchObject({ status: 'invalid', components: [{ status: 'digest-mismatch', code: 'MODEL_COMPONENT_DIGEST_MISMATCH', effect: 'none', message: expect.any(String) }] });
  await writeFile(join(directory, 'weights.safetensors'), 'wrong length');
  expect(await openModel(registration)).toMatchObject({ status: 'refused', code: 'MODEL_INCOMPLETE', issues: [{ code: 'MODEL_FILE_SIZE_MISMATCH', effect: 'none' }] });
  expect(validateModelRegistration(JSON.parse(JSON.stringify(registration)))).toEqual(registration);
});
it('preserves unsupported registrations and refuses them before looking at model files', async () => {
  const path = fixture('newer'); const original = await readFile(path);
  expect(await readModelRegistration(path)).toMatchObject({ status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED' });
  expect(await openModel(JSON.parse(original.toString()))).toMatchObject({ status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED' });
  expect(await readFile(path)).toEqual(original);
});
it('inventories missing managed bundles without creating directories and honors roots', async () => {
  const result = await inspectModels({ profile: { version: 1, modelsDirectory: join(directory, 'profile') }, modelsDirectory: join(directory, 'explicit') });
  expect(result.models.length).toBeGreaterThan(0);
  expect(result.models.every(item => item.status === 'missing' && item.directory.startsWith(join(directory, 'explicit')))).toBe(true);
  await expect(inspectModels({ modelsDirectory: 'relative' })).rejects.toMatchObject({ kind: 'invalid' });
  await expect(inspectModels({ signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
});
