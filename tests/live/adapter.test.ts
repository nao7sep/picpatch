import { testPython } from '../helpers/python.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { constants } from 'node:fs';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, setupRuntime, type Editor } from '../../src/index.ts';

it('verifies a local registration then returns a missing-runtime failure over real worker pipes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-adapter-'));
  let editor: Editor | undefined;
  try {
    const bytes = Buffer.from('not real weights');
    let uvExecutable: string | undefined;
    for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const candidate = join(entry, 'uv');
      try { await access(candidate, constants.X_OK); uvExecutable = candidate; break; } catch { /* Check next entry. */ }
    }
    if (!uvExecutable) throw new Error('The full gate requires uv on PATH.');
    const runtimeDirectory = join(directory, 'runtime');
    const cacheDirectory = (await promisify(execFile)(uvExecutable, ['cache', 'dir'])).stdout.trim();
    const runtime = await setupRuntime({ directory: runtimeDirectory, uvExecutable, cacheDirectory,
      pythonExecutable: testPython, offline: true });
    editor = createEditor({ pythonExecutable: runtime.pythonExecutable,
      model: { adapter: 'mflux-flux2-klein-4b', directory, manifest: {
        version: 1, model: 'test', source: { repository: 'test', revision: 'a'.repeat(40) },
        components: [{ path: 'weights.safetensors', role: 'weights', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
      } } });
    await writeFile(join(directory, 'weights.safetensors'), bytes);
    const sourceImage = join(directory, 'source.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toFile(sourceImage);
    await expect(editor.edit({ model: 'test', instruction: 'Edit', sourceImage, outputPath: join(directory, 'output.png') })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    expect((await readdir(directory)).sort()).toEqual(['runtime', 'source.png', 'weights.safetensors']);
  } finally { await editor?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
