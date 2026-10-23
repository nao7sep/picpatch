import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { saveArtifact, verifyArtifact } from '../../src/index.ts';
import { dirname, join } from 'node:path';
import { publishComplete, publishFile } from '../../src/images/publication.ts';
import { inspectDestination } from '../../src/images/output.ts';
import { storageScope } from '../../src/storage.ts';
import { publishSidecar } from '../../src/images/sidecar.ts';
import type { ArtifactRecord } from '../../src/contracts.generated.ts';

const controls = vi.hoisted(() => ({ flushEntered: undefined as (() => void) | undefined, flushRelease: undefined as Promise<void> | undefined, unsupported: true, entered: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      if (controls.unsupported) throw Object.assign(new Error('No hard links.'), { code: 'ENOTSUP' });
      return actual.link(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (controls.entered) {
        const entered = controls.entered;
        controls.entered = undefined;
        entered();
        await controls.release;
      }
      return actual.rename(...args);
    }),
  };
});
vi.mock('../../src/platform.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/platform.ts')>();
  return { ...actual, syncDirectory: vi.fn(async (path: string) => {
    if (controls.flushEntered) {
      const entered = controls.flushEntered;
      controls.flushEntered = undefined;
      await (await import('../../src/storage.ts')).storageWait(async () => { entered(); await controls.flushRelease; }, path);
    } else await actual.syncDirectory(path);
  }) };
});
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'picpatch-publication-')); controls.unsupported = true; });
afterEach(async () => { controls.flushEntered = undefined; controls.flushRelease = undefined; controls.entered = undefined; controls.release = undefined; await fs.rm(root, { recursive: true, force: true }); });
async function staged(name: string, bytes: string): Promise<string> {
  const directory = await fs.mkdtemp(join(root, `${name}-`));
  const path = join(directory, 'complete.png');
  await fs.writeFile(path, bytes);
  return path;
}
function heldRename() {
  let release!: () => void;
  const entered = new Promise<void>(resolve => { controls.entered = resolve; });
  controls.release = new Promise<void>(resolve => { release = resolve; });
  return { entered, release };
}

test('unsupported-link publishers retain the first complete bytes and refuse an overlapping image', async () => {
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const target = join(root, 'output.png');
  const gate = heldRename();
  const pending = publishComplete(first, target, dirname(first));
  await gate.entered;
  try {
    await expect(publishComplete(second, target, dirname(second))).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    await expect(fs.readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(second, 'utf8')).toBe('SECOND');
  } finally { gate.release(); await pending; }
  expect(await fs.readFile(target, 'utf8')).toBe('FIRST');
});

test('canonical output parents reserve the same target through a symlink spelling', async () => {
  const alias = join(root, 'alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = join(root, 'output.png');
  const [location, alternate] = await Promise.all([inspectDestination({ outputPath: target }), inspectDestination({ outputPath: join(alias, 'output.png') })]);
  expect(alternate.identity).toBe(location.identity);
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const gate = heldRename();
  const pending = publishFile(first, location.path);
  await gate.entered;
  try { await expect(publishFile(second, alternate.path)).rejects.toMatchObject({ code: 'EEXIST' }); }
  finally { gate.release(); await pending; }
  expect(await fs.readFile(target, 'utf8')).toBe('FIRST');
});

test('filesystem name equivalence protects case aliases and preserves distinct case-sensitive names', async () => {
  const probe = join(root, 'CaseProbe');
  await fs.writeFile(probe, 'probe');
  const insensitive = await fs.lstat(join(root, 'caseprobe')).then(() => true, cause => { if (cause.code === 'ENOENT') return false; throw cause; });
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const gate = heldRename();
  const pending = publishFile(first, join(root, 'Image.png'));
  await gate.entered;
  try {
    if (insensitive) await expect(publishFile(second, join(root, 'image.png'))).rejects.toMatchObject({ code: 'EEXIST' });
    else { await publishFile(second, join(root, 'image.png')); expect(await fs.readFile(join(root, 'image.png'), 'utf8')).toBe('SECOND'); }
  } finally { gate.release(); await pending; }
  expect(await fs.readFile(join(root, 'Image.png'), 'utf8')).toBe('FIRST');
});

test('a cancelled caller retains the reservation until the outstanding rename actually settles', async () => {
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const target = join(root, 'output.png');
  const controller = new AbortController();
  const gate = heldRename();
  const pending = storageScope(controller.signal, () => publishFile(first, target));
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED', effect: 'unknown' });
  await gate.entered;
  controller.abort();
  await rejected;
  try { await expect(publishFile(second, target)).rejects.toMatchObject({ code: 'EEXIST' }); }
  finally { gate.release(); }
  // The late rename publishes the winning bytes; the existing target still refuses later calls.
  await vi.waitFor(async () => { expect(await fs.readFile(target, 'utf8')).toBe('FIRST'); });
  await expect(publishFile(second, target)).rejects.toMatchObject({ code: 'EEXIST' });
});

test('normal hard-link publication still refuses existing files', async () => {
  controls.unsupported = false;
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const target = join(root, 'output.png');
  await publishFile(first, target);
  await expect(publishFile(second, target)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(target, 'utf8')).toBe('FIRST');
});

test('distinct fallback destinations publish while another rename is outstanding', async () => {
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const gate = heldRename();
  const pending = publishFile(first, join(root, 'one.png'));
  await gate.entered;
  try { await publishFile(second, join(root, 'two.png')); expect(await fs.readFile(join(root, 'two.png'), 'utf8')).toBe('SECOND'); }
  finally { gate.release(); await pending; }
});

test('filesystem name equivalence also respects composed and decomposed Unicode spellings', async () => {
  const composed = 'caf\u00e9.png', decomposed = 'cafe\u0301.png';
  const probeDirectory = await fs.mkdtemp(join(root, 'unicode-'));
  await fs.writeFile(join(probeDirectory, composed), 'probe');
  const equivalent = await fs.lstat(join(probeDirectory, decomposed)).then(() => true, cause => { if (cause.code === 'ENOENT') return false; throw cause; });
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const gate = heldRename();
  const pending = publishFile(first, join(root, composed));
  await gate.entered;
  try {
    if (equivalent) await expect(publishFile(second, join(root, decomposed))).rejects.toMatchObject({ code: 'EEXIST' });
    else { await publishFile(second, join(root, decomposed)); expect(await fs.readFile(join(root, decomposed), 'utf8')).toBe('SECOND'); }
  } finally { gate.release(); await pending; }
  expect(await fs.readFile(join(root, composed), 'utf8')).toBe('FIRST');
});

test('sidecar publication shares fallback reservations and keeps the winning record', async () => {
  const record: ArtifactRecord = JSON.parse(await fs.readFile(new URL('../fixtures/artifacts/current.json', import.meta.url), 'utf8'));
  const first = dirname(await staged('first', 'image')), second = dirname(await staged('second', 'image'));
  const target = join(root, 'output-picpatchsdk.json');
  const gate = heldRename();
  const pending = publishSidecar(record, target, target, first);
  await gate.entered;
  try {
    expect(await publishSidecar({ ...record, seed: record.seed + 1 }, target, target, second)).toMatchObject({ status: 'failed', code: 'OUTPUT_CONFLICT', effect: 'none' });
    await expect(fs.readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { gate.release(); expect(await pending).toMatchObject({ status: 'saved' }); }
  expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(record);
});

test('a failed publication releases its reservation for a later attempt', async () => {
  const missing = join(root, 'missing.png');
  const second = await staged('second', 'SECOND');
  const target = join(root, 'output.png');
  await expect(publishFile(missing, target)).rejects.toMatchObject({ code: 'ENOENT' });
  await publishFile(second, target);
  expect(await fs.readFile(target, 'utf8')).toBe('SECOND');
});

test('standalone saves return one winning artifact with corresponding bytes and provenance', async () => {
  const fixture: ArtifactRecord = JSON.parse(await fs.readFile(new URL('../fixtures/artifacts/current.json', import.meta.url), 'utf8'));
  const inputs = await Promise.all(['red', 'blue'].map(async (background, index) => {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
    const path = join(root, `input-${index}.png`);
    await fs.writeFile(path, bytes);
    return { path, bytes, record: { ...fixture, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  }));
  const target = join(root, 'saved.png');
  const gate = heldRename();
  const first = inputs[0]!, second = inputs[1]!;
  const pending = saveArtifact(first.path, target, first.record, { sidecar: true });
  await gate.entered;
  try { expect(await saveArtifact(second.path, target, second.record)).toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' }); }
  finally { gate.release(); }
  const saved = await pending;
  expect(saved.status).toBe('completed');
  if (saved.status !== 'completed') throw new Error(saved.code);
  expect(saved.record.sha256).toBe(first.record.sha256);
  expect(saved.sidecar).toMatchObject({ status: 'saved' });
  expect(await fs.readFile(target)).toEqual(first.bytes);
  expect(await verifyArtifact(target, saved.record)).toMatchObject({ status: 'completed' });
  for (const input of inputs) expect(await fs.readFile(input.path)).toEqual(input.bytes);
});

test('a stopped optional directory flush preserves the confirmed saved image and record', async () => {
  const record: ArtifactRecord = JSON.parse(await fs.readFile(new URL('../fixtures/artifacts/current.json', import.meta.url), 'utf8'));
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const source = join(root, 'source.png'), target = join(root, 'saved.png');
  await fs.writeFile(source, bytes);
  record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
  const entered = new Promise<void>(resolve => { controls.flushEntered = resolve; });
  let release!: () => void;
  controls.flushRelease = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = saveArtifact(source, target, record, {}, { signal: controller.signal });
  await entered;
  expect(await fs.readFile(target)).toEqual(bytes);
  controller.abort();
  try {
    const saved = await pending;
    expect(saved).toMatchObject({ status: 'completed', record: { sha256: record.sha256 } });
  } finally { release(); }
});
