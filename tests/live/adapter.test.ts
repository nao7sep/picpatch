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
import { createEditor, inspectReadiness, type Editor, type EditorOptions } from '../../src/index.ts';

it('accepts a local registration then returns a missing-runtime failure over real worker pipes', async () => {
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
    await promisify(execFile)(uvExecutable, ['sync', '--project', 'worker', '--python', testPython,
      '--no-python-downloads', '--no-dev', '--no-install-project', '--locked', '--no-build', '--offline',
      '--cache-dir', cacheDirectory], { env: { ...process.env, UV_PROJECT_ENVIRONMENT: runtimeDirectory }, timeout: 30_000 });
    const options: EditorOptions = { pythonExecutable: join(runtimeDirectory, 'bin/python'),
      model: { adapter: 'mflux-flux2-klein-4b', directory, manifest: {
        version: 1, model: 'test', source: { repository: 'test', revision: 'a'.repeat(40) },
        components: [{ path: 'weights.safetensors', role: 'weights', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
      } } };
    editor = createEditor(options);
    await writeFile(join(directory, 'weights.safetensors'), bytes);
    expect(await inspectReadiness(options.pythonExecutable, options.model!)).toMatchObject({ files: 'present', integrity: 'not-verified', runtime: { status: 'missing-package' } });
    const sourceImage = join(directory, 'source.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toFile(sourceImage);
    await expect(editor.edit({ model: 'test', instruction: 'Edit', sourceImage, outputPath: join(directory, 'output.png') })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    expect((await readdir(directory)).sort()).toEqual(['runtime', 'source.png', 'weights.safetensors']);
  } finally { await editor?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
