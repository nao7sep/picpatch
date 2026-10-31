import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readProfile, validateProfile, createImageClient, inspectEngine, prepareModel, listModels, supportsRuntime, type PicPatchProfile } from '../../src/index.ts';
import { profileDefaults } from '../../src/profile.ts';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-profile-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/profiles/${name}.json`, import.meta.url));
it('reads the current format without writing, and preserves unsupported versions', async () => {
  const { format, writer: _writer, ...content } = JSON.parse(await readFile(fixture('current'), 'utf8'));
  expect(await readProfile(fixture('current'))).toEqual(validateProfile(content));
  const path = join(directory, 'profile.json'); const bytes = await readFile(fixture('newer'));
  await writeFile(path, bytes);
  expect(await readProfile(path)).toMatchObject({ status: 'refused', code: 'PROFILE_VERSION_UNSUPPORTED', subject: path, details: { version: 2 } });
  expect(await readFile(path)).toEqual(bytes); expect(await readdir(directory)).toEqual(['profile.json']);
  // Another owner or kind, a missing header and an old version marker are not profiles; the writer is never read.
  for (const value of [{ format: { ...format, owner: 'gptimg' }, ...content }, { format: { ...format, kind: 'config' }, ...content }, content, { version: 1, ...content }]) {
    await writeFile(path, JSON.stringify(value));
    await expect(readProfile(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST', subject: path });
  }
  for (const writer of [undefined, [], { name: 'someone else' }]) {
    await writeFile(path, JSON.stringify({ format, ...(writer === undefined ? {} : { writer }), ...content }));
    expect(await readProfile(path)).toEqual(validateProfile(content));
  }
});
it('validates profile fields with the existing argument rules', () => {
  for (const value of [null, [], { other: 2 }, { engineDirectory: 'relative' }, { defaults: { outputDirectory: '~' } }, { timeouts: { editMs: 0 } }, { defaults: { parameters: { steps: 0 } } }]) expect(() => validateProfile(value)).toThrow();
  expect(validateProfile({ modelsDirectory: '/literal/$MODELS' })).toEqual({ status: 'completed', profile: { modelsDirectory: '/literal/$MODELS' } });
  // A held profile is content alone; identity belongs to a profile file's header.
  expect(() => validateProfile({ version: 1 })).toThrow();
  const profile: PicPatchProfile = { defaults: { seed: 1, size: { width: 256, height: 256 }, parameters: { steps: 4, guidance: 1 } } };
  expect(profileDefaults(profile, { seed: 2, parameters: { steps: 8 } })).toEqual({ seed: 2, size: { width: 256, height: 256 }, parameters: { steps: 8, guidance: 1 } });
  expect(profile.defaults?.seed).toBe(1);
});
it('uses explicit resource paths ahead of profiles and never discovers ambient settings', async () => {
  vi.stubEnv('PICPATCH_DATA_DIR', '/unexpected');
  const profile: PicPatchProfile = { engineDirectory: join(directory, 'profile-engine'), modelsDirectory: join(directory, 'profile-models') };
  // The Python engine has no build for Windows, where inspection reports unsupported.
  const python = supportsRuntime('mflux') ? 'missing' : 'unsupported';
  expect(await inspectEngine({ profile })).toMatchObject({ engineDirectory: profile.engineDirectory, status: python });
  expect(await inspectEngine({ profile, engineDirectory: join(directory, 'explicit-engine') })).toMatchObject({ engineDirectory: join(directory, 'explicit-engine'), status: python });
  const editor = createImageClient({ profile });
  const refusal = supportsRuntime('mflux') ? { code: 'ENGINE_MISSING', subject: profile.engineDirectory } : { code: 'UNSUPPORTED_CAPABILITY' };
  try { await expect(editor.generate({ model: 'test', prompt: 'A bowl.', outputDirectory: directory })).rejects.toMatchObject(refusal); }
  finally { await editor.dispose(); }
  await expect(prepareModel(listModels()[0]!.id, { profile })).rejects.toMatchObject({ code: 'MODEL_MISSING' });
  expect(await readdir(directory)).toEqual([]);
});
it('omits undefined profile timeout fields so they cannot erase worker defaults', () => {
  const profile = { timeouts: { startupMs: undefined, editMs: 50 } };
  expect(validateProfile(profile)).toEqual({ status: 'completed', profile: { timeouts: { editMs: 50 } } });
  expect(Object.hasOwn(profile.timeouts, 'startupMs')).toBe(true);
});
it('contains missing, malformed, relative and cancelled profile reads', async () => {
  await expect(readProfile('relative')).rejects.toMatchObject({ kind: 'invalid' });
  await expect(readProfile(join(directory, 'absent'))).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  await writeFile(join(directory, 'bad'), '{');
  await expect(readProfile(join(directory, 'bad'))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(readProfile(fixture('current'), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
});
