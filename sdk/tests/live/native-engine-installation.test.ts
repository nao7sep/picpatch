import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { installNativeEngine, inspectNativeEngine } from 'picpatchsdk';
import { nativeRelease } from '../../src/runtime/engine/native-release.ts';

it('installs and probes the authenticated official native archive without downloading it during tests', async () => {
  const archive = process.env.PICPATCH_NATIVE_ARCHIVE ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/native-runtime.zip', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-native-installation-'));
  const transport = vi.fn(async (url: unknown) => {
    expect(String(url)).toBe(nativeRelease.url);
    return new Response(Readable.toWeb(createReadStream(archive)) as ReadableStream<Uint8Array>, { headers: { 'content-length': String(nativeRelease.bytes) } });
  });
  vi.stubGlobal('fetch', transport);
  try {
    expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'missing' });
    const installed = await installNativeEngine({ engineDirectory: directory });
    expect(installed).toMatchObject({ status: 'ready', origin: 'installed', revision: nativeRelease.revision });
    expect(await inspectNativeEngine({ engineDirectory: directory })).toMatchObject({ status: 'ready', nativeExecutable: installed.nativeExecutable });
    expect(await installNativeEngine({ engineDirectory: directory })).toMatchObject({ origin: 'reused' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await readdir(join(directory, 'native'))).some(name => name.startsWith('.install-'))).toBe(false);
  } finally { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
