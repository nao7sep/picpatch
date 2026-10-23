import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveArtifact, verifyArtifact, type ArtifactRecord } from 'picpatchsdk';
vi.mock('node:crypto', async original => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, createHash: vi.fn(crypto.createHash) };
});
let directory: string, source: string, bytes: Buffer, record: ArtifactRecord;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-save-')); source = join(directory, 'source.png');
  bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();
  await writeFile(source, bytes);
  record = JSON.parse(await readFile(new URL('../fixtures/artifacts/current.json', import.meta.url), 'utf8'));
  record.image = { filename: 'source.png', mimeType: 'image/png', size: { width: 8, height: 8 } };
  record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('copies exact PNG bytes and saves a renamed private record without changing the original', async () => {
  const output = join(directory, 'chosen.png');
  const result = await saveArtifact(source, output, record, { sidecar: true });
  expect(result.status).toBe('completed'); if (result.status === 'refused') throw new Error(result.code);
  expect(await readFile(output)).toEqual(bytes); expect(await readFile(source)).toEqual(bytes);
  expect(result.record.image.filename).toBe('chosen.png'); expect(record.image.filename).toBe('source.png');
  expect(JSON.parse(await readFile(join(directory, 'chosen-picpatchsdk.json'), 'utf8'))).toEqual(result.record);
  expect(await verifyArtifact(output, result.record)).toMatchObject({ status: 'completed' });
  expect((await readdir(directory)).sort()).toEqual(['chosen-picpatchsdk.json', 'chosen.png', 'source.png']);
});
it('preserves a saved image when its sidecar conflicts and writes no metadata by default', async () => {
  const output = join(directory, 'chosen.png'); const sidecar = join(directory, 'chosen-picpatchsdk.json');
  await writeFile(sidecar, 'existing');
  expect(await saveArtifact(source, output, record, { sidecar: true })).toMatchObject({ status: 'completed', sidecar: { status: 'failed', code: 'OUTPUT_CONFLICT' } });
  expect(await readFile(sidecar, 'utf8')).toBe('existing');
  expect(await saveArtifact(source, join(directory, 'plain.png'), record)).not.toHaveProperty('sidecar');
  expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
});
it('refuses changed content, bad dimensions and aliases, preserving every source', async () => {
  const output = join(directory, 'out.png');
  expect(await saveArtifact(source, output, { ...record, sha256: '0'.repeat(64) })).toMatchObject({ status: 'refused', code: 'ARTIFACT_MISMATCH' });
  expect(await saveArtifact(source, output, { ...record, image: { ...record.image, size: { width: 16, height: 8 } } })).toMatchObject({ status: 'refused', code: 'ARTIFACT_MISMATCH' });
  await link(source, output);
  expect(await saveArtifact(source, output, record)).toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' });
  expect(await readFile(source)).toEqual(bytes);
  expect((await readdir(directory)).sort()).toEqual(['out.png', 'source.png']);
});
it('keeps concurrent saves independent and honours cancellation before publication', async () => {
  const output = join(directory, 'out.png');
  await expect(saveArtifact(source, output, record, {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED', effect: 'none' });
  const results = await Promise.all([saveArtifact(source, output, record), saveArtifact(source, output, record)]);
  expect(results.filter(r => r.status === 'completed')).toHaveLength(1);
  expect(results.filter(r => r.status === 'refused')).toHaveLength(1);
  expect(await readFile(output)).toEqual(bytes);
});

it('hashes the encoded bytes once while saving and still verifies the published artifact', async () => {
  vi.mocked(createHash).mockClear();
  const output = join(directory, 'one-pass.png');
  const saved = await saveArtifact(source, output, record);
  expect(saved.status).toBe('completed');
  expect(vi.mocked(createHash).mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
  if (saved.status === 'refused') throw new Error(saved.code);
  expect(await verifyArtifact(output, saved.record)).toMatchObject({ status: 'completed' });
  expect(await readFile(source)).toEqual(bytes);
});
it('refuses matching bytes whose PNG headers are readable but pixels are truncated', async () => {
  const malformed = bytes.subarray(0, Math.floor(bytes.length * 0.75));
  await writeFile(source, malformed);
  expect(await sharp(source).metadata()).toMatchObject({ format: 'png', width: 8, height: 8 });
  await expect(sharp(source, { failOn: 'warning' }).raw().toBuffer()).rejects.toThrow();
  record.bytes = malformed.length; record.sha256 = createHash('sha256').update(malformed).digest('hex');
  expect(await saveArtifact(source, join(directory, 'invalid.png'), record)).toMatchObject({ status: 'refused', code: 'ARTIFACT_MISMATCH' });
  expect(await readFile(source)).toEqual(malformed);
  expect(await readdir(directory)).toEqual(['source.png']);
});
