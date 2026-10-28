import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { installNativeEngine, inspectNativeEngine } from 'picpatchsdk';
import { nativeReleaseFor, nativeRevision } from '../../src/runtime/engine/native-release.ts';
import { liveCache } from '../helpers/live-cache.ts';

it('installs and probes the authenticated official native archive without downloading it during tests', async () => {
  const nativeRelease = nativeReleaseFor()!;
  const archive = process.env.PICPATCH_NATIVE_ARCHIVE ?? liveCache('native-runtime.zip');
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-native-installation-'));
  const transport = vi.fn(async (url: unknown) => {
    expect(String(url)).toBe(nativeRelease.url);
    return new Response(Readable.toWeb(createReadStream(archive)) as ReadableStream<Uint8Array>, { headers: { 'content-length': String(nativeRelease.bytes) } });
  });
  vi.stubGlobal('fetch', transport);
  try {
    expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'missing' });
    const installed = await installNativeEngine({ engineDirectory: directory });
    expect(installed).toMatchObject({ status: 'ready', origin: 'installed', revision: nativeRevision });
    expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'ready', nativeExecutable: installed.nativeExecutable });
    expect(await installNativeEngine({ engineDirectory: directory })).toMatchObject({ origin: 'reused' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await readdir(join(directory, 'native'))).some(name => name.startsWith('.install-'))).toBe(false);
  } finally { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});
