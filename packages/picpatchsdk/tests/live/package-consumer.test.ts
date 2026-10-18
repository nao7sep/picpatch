import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EditorOptions } from 'picpatchsdk';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = fileURLToPath(new URL('../../../../', import.meta.url));

it('packs a source SDK and runs its public worker journey from an unrelated consumer directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-package-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, timeout: 30_000 });
    const packed = Object.values(JSON.parse(stdout))[0] as { filename: string; files: { path: string }[] };
    const files = packed.files.map(file => file.path);
    expect(files).toContain('protocol/worker.schema.json');
    expect(files).toContain('runtimes/mflux/src/picpatch_worker/backends/models.json');
    expect(files).toContain('runtimes/mflux/uv.lock');
    expect(files).not.toContain('benchmarks/comparison.ts');
    expect(files.some(path => /(?:\.venv|node_modules|__pycache__|\.safetensors|\.gguf|\.pyc|inference-config)/.test(path))).toBe(false);
    await exec('tar', ['-xzf', join(directory, packed.filename), '-C', directory], { timeout: 30_000 });
    const modules = join(directory, 'node_modules'); await mkdir(modules);
    await rename(join(directory, 'package'), join(directory, 'sdk'));
    await symlink(join(directory, 'sdk'), join(modules, 'picpatchsdk'));
    // Reuse already installed dependency packages; installing the consumer needs no network.
    for (const dependency of Object.keys(pkg.dependencies)) await symlink(join(workspace, 'node_modules', dependency), join(modules, dependency));
    const config = JSON.parse(await readFile(process.env.PICPATCH_INFERENCE_CONFIG ?? join(workspace, 'node_modules/.cache/picpatch-live/inference-config.json'), 'utf8'));
    const script = join(directory, 'consumer.ts');
    await writeFile(script, `import { inspectRuntime, createEditor, listModels } from 'picpatchsdk';
const result = await inspectRuntime(${JSON.stringify(config.pythonExecutable)});
if(result.status !== 'worker-ready' || !listModels().some(model => model.id === 'sdxl-photomaker-v1')) throw new Error('Relocated runtime unavailable');
const editor = createEditor({pythonExecutable:${JSON.stringify(config.pythonExecutable)}});
try { await editor.generate({model:'unavailable',prompt:'neutral',outputPath:${JSON.stringify(join(directory, 'out.png'))}}); throw new Error('Unsupported operation accepted'); }
catch(error) { if(error.code !== 'UNSUPPORTED_CAPABILITY') throw error; }
finally { await editor.dispose(); }
console.log('consumer passed');\n`);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const { stdout: output } = await exec(process.execPath, [script], { cwd: directory, timeout: 30_000 });
    expect(output.trim()).toBe('consumer passed');
    // Seed disposable managed storage using hard links to already acquired files.
    // No model bytes are copied or changed; removing the fixture leaves the originals intact.
    const model = (config as EditorOptions).model!;
    const modelsDirectory = join(directory, 'models');
    const cached = join(modelsDirectory, model.manifest.model, model.manifest.source.revision);
    for (const component of model.manifest.components) {
      const destination = join(cached, component.path);
      await mkdir(dirname(destination), { recursive: true });
      await link(await realpath(join(model.directory, component.path)), destination);
    }
    const outputDirectory = join(directory, 'images'); await mkdir(outputDirectory);
    const native = JSON.parse(await readFile(process.env.PICPATCH_NATIVE_INFERENCE_CONFIG ?? join(workspace, 'node_modules/.cache/picpatch-live/native-inference-config.json'), 'utf8'));
    const inputs = join(directory, 'inputs.json');
    await writeFile(inputs, JSON.stringify({ pythonExecutable: config.pythonExecutable, modelId: model.manifest.model, modelsDirectory, outputDirectory, native }));
    const journey = join(directory, 'journey.ts');
    await copyFile(join(root, 'tests/fixtures/package-consumer.ts'), journey);
    const inference = await exec(process.execPath, [journey, inputs], {
      cwd: directory, timeout: 600_000,
      env: { ...process.env, HF_HUB_OFFLINE: '1' },
    });
    expect(inference.stdout.trim()).toBe('inference consumer passed');
    expect(inference.stderr).toBe('');
    await rm(join(modules, 'picpatchsdk/runtimes/mflux/src/picpatch_worker/__main__.py'));
    const missing = await exec(process.execPath, [script], { cwd: directory, timeout: 30_000 }).catch(error => error);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('Check the prepared Python dependencies and packaged worker resources.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 900_000);
