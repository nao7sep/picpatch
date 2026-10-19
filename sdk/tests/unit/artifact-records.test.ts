import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readArtifactRecord, verifyArtifact, validateArtifactRecord } from '../../src/index.ts';
import { createArtifactRecord, sidecarPath } from '../../src/images/sidecar.ts';
let directory: string;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/artifacts/${name}.json`, import.meta.url));
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-record-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('reads pinned records, preserves newer ones and rejects malformed/path-bearing records', async () => {
  const read = await readArtifactRecord(fixture('current')); if (read.status === 'refused') throw new Error(read.code); const record = read.record;
  expect(validateArtifactRecord(record)).toEqual(record);
  const path = fixture('newer'); const original = await readFile(path);
  expect(await readArtifactRecord(path)).toMatchObject({ status: 'refused', code: 'ARTIFACT_VERSION_UNSUPPORTED' });
  expect(await readFile(path)).toEqual(original);
  for (const filename of ['/secret/a.png', '..\\secret.png', '../a.png']) expect(() => validateArtifactRecord({ ...record, image: { ...record.image, filename } })).toThrow();
  await expect(readArtifactRecord('relative')).rejects.toMatchObject({ kind: 'invalid' });
});
it('checks final file bytes and full decoding without trusting names or touching originals', async () => {
  const image = join(directory, 'image.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toFile(image);
  const bytes = await readFile(image);
  const record = await createArtifactRecord({ model: 'fixture', prompt: 'private', outputPath: image }, { image: { path: image, mimeType: 'image/png', size: { width: 8, height: 8 } }, model: 'fixture', modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 42, effectiveParameters: { steps: 4 }, references: [] }, image, [], { name: 'ExampleApp', version: '1' });
  expect(record).toMatchObject({ writer: { name: 'picpatchsdk', version: '0.0.0' }, caller: { name: 'ExampleApp', version: '1' }, fingerprints: [] });
  const read = await readArtifactRecord(fixture('current')); if (read.status === 'refused') throw new Error(read.code); const pinned = read.record;
  expect({ ...record, caller: undefined, sha256: pinned.sha256, bytes: pinned.bytes, image: pinned.image }).toEqual({ ...pinned, caller: undefined });
  expect(await verifyArtifact(image, record)).toMatchObject({ status: 'verified' });
  expect(await verifyArtifact(image, { ...record, bytes: record.bytes + 1 })).toMatchObject({ status: 'refused', code: 'ARTIFACT_MISMATCH' });
  expect(await readFile(image)).toEqual(bytes);
  await writeFile(image, bytes.subarray(0, bytes.length - 10));
  expect(await verifyArtifact(image, record)).toMatchObject({ status: 'refused', code: 'ARTIFACT_MISMATCH' });
});
it('derives distinct sidecar names for generated literal basenames', () => {
  const names = Array.from({ length: 100 }, (_, i) => `image-${i}-あ space.${i}.png`);
  const paths = names.map(name => sidecarPath(join(directory, name)));
  expect(new Set(paths).size).toBe(names.length);
  expect(paths.every(path => path.startsWith(directory) && path.endsWith('-picpatchsdk.json'))).toBe(true);
});

it('reads masked records while preserving legacy records with an unknown mask mechanism', async () => {
  const original = JSON.parse(await readFile(fixture('current'), 'utf8'));
  expect(validateArtifactRecord(original)).not.toHaveProperty('maskMode');
  for (const maskMode of ['native', 'composite', 'latent-composite']) {
    const data = JSON.parse(await readFile(fixture(`masked-${maskMode}`), 'utf8'));
    expect(validateArtifactRecord(data).maskMode).toBe(maskMode);
  }
  expect(() => validateArtifactRecord({ ...original, maskMode: 'guaranteed-identity' })).toThrow();
});
