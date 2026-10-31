import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { validateModelManifest, verifyModel, type ModelManifest, type ModelComponent } from '../../src/index.ts';
let directory: string;
let manifest: ModelManifest;
function component(path: string, data: string, role: ModelComponent['role'] = 'weights'): ModelComponent {
  return { path, role, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-verify-'));
  const weight = component('weights.safetensors', 'fixture');
  manifest = { model: 'fixture', source: { repository: 'test/model', revision: 'a'.repeat(40) }, components: [weight] };
  await writeFile(join(directory, weight.path), 'fixture');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('validates independent manifests and verifies caller pins without claiming inference support', async () => {
  const copy = validateModelManifest(manifest); copy.components[0]!.path = 'other';
  const result = await verifyModel(directory, manifest);
  expect(result).toMatchObject({ status: 'matches-manifest', compatibility: 'unknown', components: [{ path: 'weights.safetensors', status: 'verified' }] });
  expect(manifest.components[0]!.path).toBe('weights.safetensors');
});
it.each(['../outside', '/absolute', 'a/../b', 'a//b', 'C:/a', 'a\\b', 'a\0b'])('rejects unsafe manifest path %s', path => {
  manifest.components[0]!.path = path; expect(() => validateModelManifest(manifest)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
});
it('rejects duplicate and file/directory collisions and mutable revisions', () => {
  manifest.components.push({ ...manifest.components[0]!, path: 'WEIGHTS.SAFETENSORS' });
  expect(() => validateModelManifest(manifest)).toThrow();
  manifest.components[1]!.path = 'weights.safetensors/config.json'; expect(() => validateModelManifest(manifest)).toThrow();
  manifest.components.pop(); manifest.source.revision = 'main'; expect(() => validateModelManifest(manifest)).toThrow();
});
it.each(['missing', 'size-mismatch', 'digest-mismatch', 'not-file'])('reports %s without deleting or repairing inputs', async status => {
  const path = join(directory, 'weights.safetensors');
  if (status === 'missing') await rm(path);
  if (status === 'size-mismatch') await writeFile(path, 'short');
  if (status === 'digest-mismatch') await writeFile(path, 'altered');
  if (status === 'not-file') { await rm(path); await mkdir(path); }
  expect(await verifyModel(directory, manifest)).toMatchObject({ status: 'invalid', components: [{ status }] });
});
it('allows cached file symlinks but rejects escaping directory symlinks', async () => {
  await mkdir(join(directory, 'root')); await symlink(join(directory, 'weights.safetensors'), join(directory, 'root', 'weights.safetensors'));
  expect((await verifyModel(join(directory, 'root'), manifest)).status).toBe('matches-manifest');
  await symlink(directory, join(directory, 'root', 'external'));
  manifest.components[0]!.path = 'external/weights.safetensors';
  expect(await verifyModel(join(directory, 'root'), manifest)).toMatchObject({ components: [{ status: 'path-escape' }] });
});
it.each([
  ['{"weight_map":{"layer":"weights.safetensors"}}', 'verified'],
  ['{"weight_map":{"layer":"missing.safetensors"}}', 'invalid-index'],
  ['{"weight_map":{"layer":"../weights.safetensors"}}', 'invalid-index'],
  ['{"weight_map":["weights.safetensors"]}', 'invalid-index'],
  ['{"weight_map":{}}', 'invalid-index'],
  ['{"weight_map":{"layer":1}}', 'invalid-index'],
  ['{"weight_map":', 'invalid-index'],
  ['{"weight_map":{"layer":"weights.safetensors"},}', 'invalid-index'],
  ['{"weight_map":{"layer":"weights.safetensors"}}{}', 'invalid-index'],
])('checks shard-index structure and membership: %s', async (data, status) => {
  manifest.components.push(component('model.safetensors.index.json', data, 'shard-index'));
  await writeFile(join(directory, 'model.safetensors.index.json'), data);
  const result = await verifyModel(directory, manifest); expect(result.components[1]!.status).toBe(status);
});
it('supports cancellation and ignores callback failures', async () => {
  const controller = new AbortController();
  await expect(verifyModel(directory, manifest, { signal: controller.signal, onEvent: () => controller.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(verifyModel(directory, manifest, { onProgress: () => { throw new Error('listener'); } })).resolves.toHaveProperty('components');
});
it('preserves filesystem failures instead of claiming missing models', async () => {
  await expect(verifyModel(join(directory, 'missing'), manifest)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', cause: { code: 'ENOENT' } });
});

it('refuses an invalid time budget', async () => {
  await expect(verifyModel(directory, manifest, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
