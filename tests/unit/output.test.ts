import { mkdtemp, rm, readFile, writeFile, readdir, symlink, link, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageWorkspace } from '../../src/images/output.ts';
import { ImageEditor } from '../../src/images/editor.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, type EditRequest, type EditResult, type Editor } from '../../src/index.ts';
let directory: string;
let request: EditRequest;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-output-'));
  const source = join(directory, 'source.png');
  await sharp({ create: { width: 4, height: 3, channels: 3, background: '#345678' } }).png().toFile(source);
  request = { model: 'test', instruction: 'Edit', sourceImage: source, outputPath: join(directory, 'out.png'), seed: 2 };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function result(request: EditRequest): EditResult {
  return { image: { path: request.outputPath, mimeType: 'image/png', size: { width: 4, height: 3 } }, model: 'test', modelRevision: 'rev', runtime: { name: 'test', version: '1' }, seed: 2, references: request.references ?? [] };
}
async function render(request: EditRequest) { await sharp(request.sourceImage!).png().toFile(request.outputPath); return result(request); }
async function workspace() { const work = await ImageWorkspace.create(request); await work.prepare(); return work; }
async function leftovers() { return (await readdir(directory)).filter(name => name.startsWith('.picpatch-')); }
function backend(edit: Editor['edit'] = render): Editor { return { edit, dispose: async () => {} }; }

describe('safe image publication', () => {
  it('publishes a verified complete PNG, restores caller paths and cleans private data', async () => {
    const original = await readFile(request.sourceImage!); let staged: EditRequest | undefined;
    const editor = new ImageEditor(backend(async r => { staged = r; expect(await readdir(directory)).not.toContain('out.png'); return render(r); }));
    const saved = await editor.edit(request); expect(saved.image.path).toBe(request.outputPath);
    expect(staged!.sourceImage).not.toBe(request.sourceImage); expect(staged!.outputPath).not.toBe(request.outputPath);
    expect((await sharp(saved.image.path).metadata()).format).toBe('png');
    expect(await readFile(request.sourceImage!)).toEqual(original); expect(await leftovers()).toEqual([]);
    expect((await stat(saved.image.path)).mode & 0o777).toBe(0o600); await editor.dispose();
  });
  it.each(['file', 'symlink', 'dangling', 'hardlink'])('refuses existing output %s without modifying it', async kind => {
    if (kind === 'file') await writeFile(request.outputPath, 'original');
    if (kind === 'symlink') await symlink(request.sourceImage!, request.outputPath);
    if (kind === 'dangling') await symlink(join(directory, 'missing'), request.outputPath);
    if (kind === 'hardlink') await link(request.sourceImage!, request.outputPath);
    const execute = vi.fn(render); const editor = new ImageEditor(backend(execute));
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
    expect(execute).not.toHaveBeenCalled(); expect(await leftovers()).toEqual([]);
    if (kind === 'file') expect(await readFile(request.outputPath, 'utf8')).toBe('original'); await editor.dispose();
  });
  it('never clobbers a destination that appears during rendering and retains recovery data', async () => {
    const work = await workspace(); const reply = await render(work.workerRequest);
    await writeFile(request.outputPath, 'other writer');
    await expect(work.publish(reply)).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT', recoveryDirectory: work.directory });
    await work.cleanup(); expect(await readFile(request.outputPath, 'utf8')).toBe('other writer');
    expect((await sharp(join(work.directory, 'complete.png')).metadata()).width).toBe(4);
  });
  it('allows exactly one concurrent publisher', async () => {
    const a = await workspace(); const b = await workspace();
    const ra = await render(a.workerRequest); const rb = await render(b.workerRequest);
    const outcomes = await Promise.allSettled([a.publish(ra), b.publish(rb)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await sharp(request.outputPath).metadata()).width).toBe(4);
    await a.cleanup(); await b.cleanup();
  });
  it.each(['missing', 'malformed', 'wrong dimensions', 'symlink', 'jpeg'])('rejects %s worker output and leaves no destination', async mode => {
    const editor = new ImageEditor(backend(async r => {
      if (mode === 'malformed') await writeFile(r.outputPath, 'bad');
      if (mode === 'wrong dimensions') await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toFile(r.outputPath);
      if (mode === 'symlink') await symlink(r.sourceImage!, r.outputPath);
      if (mode === 'jpeg') await sharp(r.sourceImage!).jpeg().toFile(r.outputPath);
      return result(r);
    }));
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(await readdir(directory)).not.toContain('out.png'); expect(await leftovers()).toEqual([]); await editor.dispose();
  });
  it('rejects mask size mismatch before submitting any work', async () => {
    const mask = join(directory, 'mask.png'); await sharp(Buffer.alloc(1), { raw: { width: 1, height: 1, channels: 1 } }).toColourspace('b-w').png().toFile(mask);
    const execute = vi.fn(render); const editor = new ImageEditor(backend(execute));
    await expect(editor.edit({ ...request, maskImage: mask })).rejects.toMatchObject({ code: 'INVALID_MASK' }); expect(execute).not.toHaveBeenCalled(); expect(await leftovers()).toEqual([]); await editor.dispose();
  });
  it('rejects aliased references and restores ordered original references in results', async () => {
    const alias = join(directory, 'alias.png'); await link(request.sourceImage!, alias);
    const editor = new ImageEditor(backend());
    await expect(editor.edit({ ...request, references: [{ id: 'a', role: 'subject', images: [request.sourceImage!, alias] }] })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    const refs: NonNullable<EditRequest['references']> = [{ id: 'a', role: 'subject' as const, images: [alias] as [string] }];
    expect((await editor.edit({ ...request, references: refs })).references).toEqual(refs); await editor.dispose();
  });
  it('retains temporary files when worker termination cannot be confirmed', async () => {
    const editor = new ImageEditor(backend(async () => { throw new PicPatchRuntimeError('TERMINATION_FAILED', 'Unconfirmed'); }));
    const failure = await editor.edit(request).catch(error => error);
    expect(failure).toMatchObject({ code: 'TERMINATION_FAILED', recoveryDirectory: expect.any(String) });
    expect(await leftovers()).toHaveLength(1); await editor.dispose();
  });
  it('waits for active work before cleanup during disposal', async () => {
    const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>(); let path = '';
    const editor = new ImageEditor(backend(async r => { path = r.sourceImage!; started.resolve(); await finish.promise; throw new PicPatchCancelledError(); }));
    const edit = editor.edit(request); const caught = expect(edit).rejects.toMatchObject({ code: 'CANCELLED' }); await started.promise;
    let disposed = false; const disposal = editor.dispose().then(() => { disposed = true; });
    await Promise.resolve(); expect(disposed).toBe(false); expect((await stat(path)).isFile()).toBe(true);
    finish.resolve(); await disposal; await caught; expect(await leftovers()).toEqual([]);
  });
  it('blocks reentrant edits from progress callbacks', async () => {
    const editor = new ImageEditor(backend()); let reentrant: Promise<unknown> | undefined;
    await editor.edit(request, { onProgress: () => { reentrant = expect(editor.edit(request)).rejects.toMatchObject({ code: 'BUSY' }); } });
    await reentrant; await editor.dispose();
  });
  it('does not publish if cancellation arrives after the worker finishes', async () => {
    const controller = new AbortController(); const editor = new ImageEditor(backend(async r => { const reply = await render(r); controller.abort(); return reply; }));
    await expect(editor.edit(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(directory)).not.toContain('out.png'); expect(await leftovers()).toEqual([]); await editor.dispose();
  });
});

describe('cleanup reporting', () => {
  it('preserves successful publication when temporary cleanup fails', async () => {
    const cleanup = vi.spyOn(ImageWorkspace.prototype, 'cleanup').mockRejectedValue(new Error('cleanup failed'));
    const editor = new ImageEditor(backend());
    try {
      const saved = await editor.edit(request);
      expect(saved.cleanupWarning).toMatchObject({ directory: expect.any(String) });
      expect((await sharp(saved.image.path).metadata()).width).toBe(4);
    } finally { cleanup.mockRestore(); await editor.dispose(); }
  });
  it('reports both the original failure and failed cleanup', async () => {
    const cleanup = vi.spyOn(ImageWorkspace.prototype, 'cleanup').mockRejectedValue(new Error('cleanup failed'));
    const editor = new ImageEditor(backend(async () => { throw new Error('worker failure'); }));
    try { await expect(editor.edit(request)).rejects.toMatchObject({ code: 'CLEANUP_FAILED', recoveryDirectory: expect.any(String), cause: expect.any(AggregateError) }); }
    finally { cleanup.mockRestore(); await editor.dispose(); }
  });
});
