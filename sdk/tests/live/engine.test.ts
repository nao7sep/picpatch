import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, inspectEngine, installEngine } from 'picpatchsdk';
import { testEngineDirectory } from '../helpers/engine.ts';

const exec = promisify(execFile);
it('installs independent locked environments, shares only complete readiness, and runs real inference', async () => {
  const toolDirectories = (process.env.PATH ?? '').split(delimiter).filter(path => path.startsWith('/'));
  let uvExecutable = process.env.PICPATCH_UV_EXECUTABLE;
  if (!uvExecutable) {
    for (const directory of toolDirectories) {
      const candidate = join(directory, 'uv');
      try { await access(candidate, constants.X_OK); uvExecutable = candidate; break; } catch { /* Next caller-owned tool location. */ }
    }
  }
  if (!uvExecutable) throw new Error('Supply an absolute PICPATCH_UV_EXECUTABLE or uv on PATH for managed-engine tests.');
  const cacheDirectory = (await exec(uvExecutable, ['cache', 'dir'])).stdout.trim();
  // The explicit installation path is the only acquisition path, including in the full gate.
  const base = await installEngine({ uvExecutable, engineDirectory: testEngineDirectory, cacheDirectory, toolDirectories });
  expect(base.status).toBe('ready');
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-real-engine-'));
  try {
    const options = { uvExecutable, engineDirectory: join(directory, 'engine'), cacheDirectory, pythonDirectory: join(testEngineDirectory, 'python'), toolDirectories, offline: true };
    const [first, second] = await Promise.all([installEngine(options), installEngine(options)]);
    expect(first.origin).toBe('installed'); expect(second.origin).toBe('installed');
    expect(first.pythonExecutable).not.toBe(second.pythonExecutable);
    expect(first.identity).toEqual(base.identity);
    expect(await inspectEngine({ engineDirectory: options.engineDirectory })).toMatchObject({ status: 'ready' });
    expect(await installEngine(options)).toMatchObject({ origin: 'reused' });
    for (const engine of [first, second]) {
      const check = await exec(engine.pythonExecutable, ['-I', '-c', 'import importlib.util, sys; assert sys.version_info[:3] == (3,15,0); assert importlib.util.find_spec("picpatch_worker") is None; print("ok")'], { timeout: 30_000 });
      expect(check.stdout.trim()).toBe('ok');
      expect(await readFile(join(dirname(dirname(engine.pythonExecutable)), 'pyvenv.cfg'), 'utf8')).not.toContain('/opt/homebrew');
    }
    const configPath = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const editor = createImageClient({ engineDirectory: options.engineDirectory, model: config.model, defaults: { outputDirectory: directory, size: { width: 256, height: 256 }, seed: 42, parameters: { steps: 2 } } });
    try {
      const generated = await editor.generate({ prompt: 'A blue ceramic bowl on a white table.', sidecar: {} });
      if ('status' in generated) throw new Error(generated.code);
      const edited = await editor.edit({ sourceImage: generated.image.path, instruction: 'Make the bowl green.', sidecar: {} });
      if ('status' in edited) throw new Error(edited.code);
      for (const result of [generated, edited]) {
        expect(await sharp(result.image.path).metadata()).toMatchObject({ width: 256, height: 256 });
        expect(await readFile(result.sidecar!.path, 'utf8')).not.toContain(directory);
      }
    } finally { await editor.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 600_000);
