import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { saveArtifact } from '../../src/index.ts';
import { dirname, join } from 'node:path';
import { publishComplete, publishFile } from '../../src/images/publication.ts';
import { storageScope } from '../../src/storage.ts';
import type { ArtifactRecord } from '../../src/contracts.generated.ts';

const controls = vi.hoisted(() => ({ unsupported: false, failRename: false, entered: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      if (controls.unsupported) throw Object.assign(new Error('No hard links.'), { code: 'ENOTSUP' });
      return actual.link(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (controls.failRename) { controls.failRename = false; throw Object.assign(new Error('I/O error.'), { code: 'EIO' }); }
      const entered = controls.entered;
      if (entered) { controls.entered = undefined; entered(); await controls.release; }
      return actual.rename(...args);
    }),
  };
});
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'picpatch-publication-')); controls.unsupported = false; });
afterEach(async () => { Object.assign(controls, { entered: undefined, release: undefined }); await fs.rm(root, { recursive: true, force: true }); });
async function staged(name: string, bytes: string): Promise<string> {
  const directory = await fs.mkdtemp(join(root, `${name}-`));
  const path = join(directory, 'complete.png');
  await fs.writeFile(path, bytes);
  return path;
}
/** Holds the next rename until released. */
function heldRename() {
  let release!: () => void;
  const entered = new Promise<void>(resolve => { controls.entered = resolve; });
  controls.release = new Promise<void>(resolve => { release = resolve; });
  return { entered, release };
}

test('without hard links, an overlapping publisher is refused and the first bytes stand', async () => {
  controls.unsupported = true;
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const target = join(root, 'output.png');
  const gate = heldRename();
  const pending = publishComplete(first, target, dirname(first));
  await gate.entered;
  try {
    await expect(publishComplete(second, target, dirname(second))).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    expect(await fs.readFile(second, 'utf8')).toBe('SECOND');
  } finally { gate.release(); await pending; }
  expect(await fs.readFile(target, 'utf8')).toBe('FIRST');
});

test('without hard links, the claim covers symlinked parents and case or Unicode spellings of the name', async () => {
  controls.unsupported = true;
  const alias = join(root, 'alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const first = await staged('first', 'FIRST');
  const gate = heldRename();
  const pending = publishFile(first, join(root, 'Caf\u00e9.png'));
  await gate.entered;
  try {
    for (const spelling of [join(alias, 'Caf\u00e9.png'), join(root, 'CAF\u00c9.png'), join(root, 'Cafe\u0301.png')]) {
      await expect(publishFile(await staged('other', 'OTHER'), spelling)).rejects.toMatchObject({ code: 'EEXIST' });
    }
    await publishFile(await staged('distinct', 'DISTINCT'), join(root, 'other.png'));
  } finally { gate.release(); await pending; }
  expect(await fs.readFile(join(root, 'Caf\u00e9.png'), 'utf8')).toBe('FIRST');
});

test('a failed rename frees its name claim for a later attempt', async () => {
  controls.unsupported = true; controls.failRename = true;
  const first = await staged('first', 'FIRST'), second = await staged('second', 'SECOND');
  const target = join(root, 'output.png');
  await expect(publishFile(first, target)).rejects.toMatchObject({ code: 'EIO' });
  await publishFile(second, target);
  expect(await fs.readFile(target, 'utf8')).toBe('SECOND');
});

test('a caller that stops waiting keeps the name claimed until its rename settles', async () => {
  controls.unsupported = true;
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
  await vi.waitFor(async () => { expect(await fs.readFile(target, 'utf8')).toBe('FIRST'); });
  await expect(publishFile(second, target)).rejects.toMatchObject({ code: 'EEXIST' });
});

test('hard-link publication refuses existing files', async () => {
  const first = join(root, 'first.png'), second = join(root, 'second.png'), target = join(root, 'output.png');
  await fs.writeFile(first, 'FIRST'); await fs.writeFile(second, 'SECOND');
  await publishFile(first, target);
  await expect(publishFile(second, target)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(target, 'utf8')).toBe('FIRST');
});

test('a private copy that cannot be read fails the save as I/O, not as a mismatched artifact', async () => {
  const fingerprint = await import('../../src/images/fingerprint.ts');
  const original = fingerprint.inspectImageMetadata;
  const spy = vi.spyOn(fingerprint, 'inspectImageMetadata').mockImplementation(async (path, signal, decode) => { await fs.rm(path); return original(path, signal, decode); });
  try {
    const record: ArtifactRecord = JSON.parse(await fs.readFile(new URL('../fixtures/artifacts/current.json', import.meta.url), 'utf8'));
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    const source = join(root, 'source.png'); await fs.writeFile(source, bytes);
    record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
    await expect(saveArtifact(source, join(root, 'saved.png'), record)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', kind: 'unavailable' });
    expect(spy).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
