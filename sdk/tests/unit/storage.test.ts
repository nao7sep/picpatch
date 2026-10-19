import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImageClientImpl } from '../../src/execution/session.ts';
import { open, writeFile, storageScope, storageStalled } from '../../src/storage.ts';
import { withDeadline } from '../../src/operations.ts';
vi.mock('node:fs/promises', async original => { const actual = await original<typeof fs>(); return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) }; });
const actual = await vi.importActual<typeof fs>('node:fs/promises');
let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'picpatch-storage-')); });
afterEach(async () => { vi.mocked(fs.open).mockImplementation(actual.open); vi.mocked(fs.link).mockImplementation(actual.link); await fs.rm(directory, { recursive: true, force: true }); });
it('closes a late-opened descriptor without using it after the deadline', async () => {
  const path = join(directory, 'input'); await fs.writeFile(path, 'x');
  const handle = await actual.open(path, 'r'); const close = vi.spyOn(handle, 'close');
  const pending = Promise.withResolvers<typeof handle>();
  vi.mocked(fs.open).mockReturnValueOnce(pending.promise);
  const use = vi.fn();
  await expect(withDeadline(undefined, 10, 'Read timed out.', async () => { const file = await open(path, 'r'); use(file); })).rejects.toMatchObject({ code: 'TIMEOUT', effect: 'none', subject: path });
  pending.resolve(handle); await expect.poll(() => close.mock.calls.length).toBe(1); expect(use).not.toHaveBeenCalled();
});
it('bounds a stalled publication, retains owned files, and never resumes sidecar work after late settlement', async () => {
  const path = join(directory, 'image.png'); const pending = Promise.withResolvers<void>(); let publish: (() => Promise<void>) | undefined;
  vi.mocked(fs.link).mockImplementation((...args) => { publish = () => actual.link(...args); return pending.promise; });
  const render = async (request: { outputPath: string; model: string }) => {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toFile(request.outputPath);
    return { image: { path: request.outputPath, mimeType: 'image/png' as const, size: { width: 8, height: 8 } }, model: request.model, modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' }, seed: 1, effectiveParameters: {}, references: [] };
  };
  const editor = new ImageClientImpl({ validate: async () => ({ model: 'fixture', textToImage: true, instructionEditing: true, referenceRoles: [], maskMode: 'none' }), generate: render, edit: render, dispose: async () => {} }, {}, 'fixture');
  try {
    await expect(editor.generate({ prompt: 'Bowl', outputPath: path, sidecar: {} }, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT', effect: 'unknown', details: { recoveryDirectory: expect.any(String) } });
    expect(publish).toBeDefined(); expect((await fs.readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(true);
    await publish!(); pending.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await sharp(path).metadata()).format).toBe('png');
    expect(await fs.readdir(directory)).not.toContain('image-picpatchsdk.json');
  } finally { await editor.dispose(); }
});

it('propagates a nested stalled read to the owner of private writes', async () => {
  const path = join(directory, 'private');
  const handle = await actual.open(join(directory, 'read'), 'w+');
  const pending = Promise.withResolvers<typeof handle>();
  await storageScope(new AbortController().signal, async () => {
    await writeFile(path, 'owned');
    vi.mocked(fs.open).mockReturnValueOnce(pending.promise);
    await expect(withDeadline(undefined, 10, 'Nested read timed out.', () => open(join(directory, 'read'), 'r'))).rejects.toMatchObject({ code: 'TIMEOUT', effect: 'unknown' });
    expect(storageStalled()).toBe(true);
  });
  pending.resolve(handle);
  await new Promise(resolve => setTimeout(resolve, 10));
});
