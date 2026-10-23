import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { processDiagnostics } from '../../src/process-diagnostics.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), rm: vi.fn(actual.rm) };
});
afterEach(() => vi.clearAllMocks());

it('streams repeated verbose healthy output with backpressure without reading the full text', async () => {
  const source = new PassThrough({ highWaterMark: 1024 });
  const errors = vi.fn();
  const diagnostics = processDiagnostics(source, errors);
  const chunk = Buffer.alloc(64 * 1024, 'x');
  let backpressured = false;
  for (let i = 0; i < 256; i++) {
    if (!source.write(chunk)) { backpressured = true; await once(source, 'drain'); }
  }
  expect(backpressured).toBe(true);
  expect(fs.readFile).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  source.end();
  expect(await diagnostics.finish(false)).toBeUndefined();
  expect(fs.readFile).not.toHaveBeenCalled();
  const directory = await vi.mocked(fs.mkdtemp).mock.results[0]!.value;
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('materializes complete terminal diagnostics only on failure, including split UTF-8 and final bytes', async () => {
  const source = new PassThrough();
  const errors = vi.fn();
  const diagnostics = processDiagnostics(source, errors);
  const expected = 'start\n' + 'verbose 日本語\n'.repeat(100_000) + 'terminal end\n';
  const bytes = Buffer.from(expected);
  for (let i = 0; i < bytes.length; i += 32767) {
    if (!source.write(bytes.subarray(i, i + 32767))) await once(source, 'drain');
  }
  expect(fs.readFile).not.toHaveBeenCalled();
  source.end();
  expect(await diagnostics.finish(true)).toBe(expected);
  expect(errors).not.toHaveBeenCalled();
  expect(fs.readFile).toHaveBeenCalledOnce();
  const directory = await vi.mocked(fs.mkdtemp).mock.results[0]!.value;
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports temporary storage failure and retains it through settlement instead of losing diagnostics silently', async () => {
  const source = new PassThrough();
  const cause = Object.assign(new Error('full disk'), { code: 'ENOSPC' });
  vi.mocked(fs.open).mockRejectedValueOnce(cause);
  const errors = vi.fn(() => source.end());
  const diagnostics = processDiagnostics(source, errors);
  source.write('diagnostic');
  await expect(diagnostics.finish(true)).rejects.toBe(cause);
  expect(errors).toHaveBeenCalledWith(cause);
  const directory = await vi.mocked(fs.mkdtemp).mock.results[0]!.value;
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('closes the spool handle after a streaming write failure and surfaces the original cause', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  const source = new PassThrough();
  const cause = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
  const closed = vi.fn();
  vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(cause);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closed(); });
    return handle;
  });
  const errors = vi.fn();
  const diagnostics = processDiagnostics(source, errors);
  source.end('complete diagnostic');
  await expect(diagnostics.finish(true)).rejects.toBe(cause);
  expect(errors).toHaveBeenCalledWith(cause);
  expect(closed).toHaveBeenCalledOnce();
});

it('reports cleanup failure after the capture has settled', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  const source = new PassThrough();
  const cause = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
  vi.mocked(fs.rm).mockRejectedValueOnce(cause);
  const diagnostics = processDiagnostics(source, vi.fn());
  source.end('terminal text');
  await expect(diagnostics.finish(true)).rejects.toMatchObject({ cause, message: expect.stringContaining('terminal text') });
  const directory = await vi.mocked(fs.mkdtemp).mock.results[0]!.value;
  await actual.rm(directory, { recursive: true });
});
