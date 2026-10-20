import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { installNativeEngine, inspectNativeEngine } from 'picpatchsdk';
import { nativeRevision } from '../../src/backends/stable-diffusion-cpp/models.ts';
import * as storage from '../../src/storage.ts';
const fixture = vi.hoisted(() => ({ files: { 'sd-cli': 4, 'libstable-diffusion.dylib': 4, 'ggml.txt': 4, 'stable-diffusion.cpp.txt': 4 } }));
vi.mock('../../src/runtime/engine/native-release.ts', async () => {
  const { createHash } = await import('node:crypto');
  const release = { url: 'https://example.invalid/runtime.zip', bytes: 7, sha256: createHash('sha256').update('archive').digest('hex'), executable: 'sd-cli', files: fixture.files };
  return { nativeRevision: '95b3090664d019fcf8fa032a44d1d4793ba244b8', nativeReleases: { 'darwin-arm64': release }, nativeReleaseFor: () => release };
});
vi.mock('../../src/runtime/engine/command.ts', () => ({ runCommand: vi.fn(async (executable: string, args: string[]) => {
  if (/[\\/]tar(\.exe)?$/.test(executable)) for (const name of Object.keys(fixture.files)) await writeFile(join(args[3]!, name), 'data');
  return `stable-diffusion.cpp version unknown, commit ${nativeRevision.slice(0, 7)}\n`;
}) }));
let directory: string;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-native-engine-'));
  fetcher = vi.fn(async () => new Response('archive', { headers: { 'content-length': '7' } }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
it('inspects without acquisition and publishes or reuses complete native files', async () => {
  expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'missing', code: 'ENGINE_MISSING', message: expect.any(String) });
  expect(fetcher).not.toHaveBeenCalled();
  const result = await installNativeEngine({ engineDirectory: directory });
  expect(result).toMatchObject({ status: 'ready', code: 'ENGINE_READY', message: expect.any(String), origin: 'installed' });
  expect(await readFile(result.nativeExecutable, 'utf8')).toBe('data');
  expect(await installNativeEngine({ engineDirectory: directory })).toMatchObject({ origin: 'reused', nativeExecutable: result.nativeExecutable });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await readdir(join(directory, 'native'))).some(name => name.startsWith('.install-'))).toBe(false);
});
it('refuses corrupt transport and preserves prior incompatible files', async () => {
  fetcher.mockImplementation(async () => new Response('corrupt'));
  await expect(installNativeEngine({ engineDirectory: directory })).rejects.toMatchObject({ code: 'ENGINE_INCOMPATIBLE' });
  expect(await readdir(join(directory, 'native'))).toEqual([]);
  fetcher.mockImplementation(async () => new Response('archive'));
  const good = await installNativeEngine({ engineDirectory: directory });
  await writeFile(good.nativeExecutable, 'changed');
  expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'incompatible', code: 'ENGINE_CHECK_FAILED', message: expect.any(String) });
  await expect(installNativeEngine({ engineDirectory: directory })).rejects.toMatchObject({ code: 'ENGINE_INCOMPATIBLE' });
  expect(await readFile(good.nativeExecutable, 'utf8')).toBe('changed');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('handles two independent installs without locks or partial readiness', async () => {
  const results = await Promise.all([installNativeEngine({ engineDirectory: directory }), installNativeEngine({ engineDirectory: directory })]);
  expect(results[0]!.nativeExecutable).toBe(results[1]!.nativeExecutable);
  expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'ready' });
});
it('rejects relative paths and cancellation before creating files', async () => {
  await expect(installNativeEngine({ engineDirectory: 'relative' })).rejects.toMatchObject({ kind: 'invalid' });
  await expect(installNativeEngine({ engineDirectory: directory, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readdir(directory)).toEqual([]);
});
it('retains staging after uncertain publication instead of deleting possibly published files', async () => {
  vi.spyOn(storage, 'rename').mockRejectedValue(Object.assign(new Error('I/O'), { code: 'EIO' }));
  await expect(installNativeEngine({ engineDirectory: directory })).rejects.toMatchObject({ effect: 'unknown', details: { recoveryDirectory: expect.any(String) } });
  expect((await readdir(join(directory, 'native'))).some(name => name.startsWith('.install-'))).toBe(true);
});
it('keeps a published engine ready and reports unsuccessful staging cleanup', async () => {
  vi.spyOn(storage, 'rm').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const result = await installNativeEngine({ engineDirectory: directory });
  expect(result).toMatchObject({ status: 'ready', cleanupWarning: { directory: expect.any(String) } });
  expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'ready' });
});
it('cancels preparation before publication and removes only its settled staging', async () => {
  const controller = new AbortController();
  fetcher.mockImplementation(async () => { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
  await expect(installNativeEngine({ engineDirectory: directory, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readdir(join(directory, 'native'))).toEqual([]);
});
