import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation } from '../operations.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { inspectRuntime } from './inspection.ts';
import { runInstaller } from './command.ts';
import type { RuntimeOperationOptions, RuntimeSetupRequest, RuntimeSetupResult } from './types.ts';

/** Explicit setup owns its interpreter and packages, but never acquires model weights. */
export async function setupRuntime(input: RuntimeSetupRequest, options: RuntimeOperationOptions = {}): Promise<RuntimeSetupResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['directory', 'pythonExecutable', 'uvExecutable', 'offline', 'cacheDirectory', 'inference'].includes(k))) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid runtime setup request.');
  for (const path of [input.directory, input.uvExecutable]) absolutePath(path);
  if (input.pythonExecutable !== undefined) absolutePath(input.pythonExecutable);
  if (input.inference !== undefined && typeof input.inference !== 'boolean') throw new PicPatchUsageError('INVALID_REQUEST', 'inference must be a boolean.');
  if (input.pythonExecutable === undefined && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new PicPatchUsageError('INVALID_REQUEST', 'Managed Python currently supports macOS arm64. Supply an interpreter on other platforms.');
  if (input.cacheDirectory !== undefined) absolutePath(input.cacheDirectory);
  if (input.offline !== undefined && typeof input.offline !== 'boolean') throw new PicPatchUsageError('INVALID_REQUEST', 'offline must be a boolean.');
  validateOperation(options, ['timeoutMs']);
  const request = { ...input }; const operation = { ...options };
  const budget = timeBudget(operation.timeoutMs, 300_000); checkSignal(operation.signal);
  let directory: string | undefined; let owned = false;
  try {
    directory = join(await realpath(dirname(request.directory)), basename(request.directory));
    try { await mkdir(directory, { mode: 0o700 }); owned = true; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new PicPatchUsageError('OUTPUT_CONFLICT', 'Runtime directory already exists; inspect it or select an unused location.', { cause }); throw cause; }
    const project = join(directory, 'project'); await mkdir(project);
    const lock = await readFile(new URL('../../worker/uv.lock', import.meta.url));
    const pyproject = await readFile(new URL('../../worker/pyproject.toml', import.meta.url));
    await writeFile(join(project, 'uv.lock'), lock, { flag: 'wx', mode: 0o600 });
    await writeFile(join(project, 'pyproject.toml'), pyproject, { flag: 'wx', mode: 0o600 });
    const environment = join(directory, 'environment');
    const cache = request.cacheDirectory ?? join(directory, 'cache');
    // Environment variables must not redirect writes or silently change the locked installation.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(UV_|PYTHON|PIP_|VIRTUAL_ENV$)/i.test(key)));
    env.UV_PROJECT_ENVIRONMENT = environment;
    env.UV_PYTHON_INSTALL_DIR = join(directory, 'python');
    env.UV_PYTHON_BIN_DIR = join(directory, 'bin');
    const deadline = Date.now() + budget;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw new PicPatchRuntimeError('TIMEOUT', 'Runtime setup timed out.');
      return value;
    };
    const common = ['--no-config', '--cache-dir', cache, ...(request.offline ? ['--offline'] : [])];
    const managed = request.pythonExecutable === undefined;
    if (managed) {
      emitProgress(operation, { type: 'progress', verb: 'setupRuntime', stage: 'installing-python', message: 'Installing managed Python 3.15.0.' });
      // Astral's standalone CPython distribution is used because python.org does not
      // ship a relocatable build. uv owns archive verification against its catalogue,
      // extraction and platform selection. No global shims or registry entries.
      await runInstaller(request.uvExecutable, ['python', 'install', '3.15.0', '--no-bin', '--no-registry', ...common], directory, env, remaining(), operation.signal);
    }
    emitProgress(operation, { type: 'progress', verb: 'setupRuntime', stage: 'installing', message: 'Installing locked worker dependencies.' });
    await runInstaller(request.uvExecutable, ['sync', '--project', project, '--python', request.pythonExecutable ?? '3.15.0', ...(managed ? ['--managed-python'] : []), '--no-python-downloads', '--no-dev', '--no-install-project', '--locked', ...(request.inference ? ['--extra', 'inference'] : ['--no-build']), '--link-mode', 'copy', ...common], directory, env, remaining(), operation.signal);
    checkSignal(operation.signal);
    emitProgress(operation, { type: 'progress', verb: 'setupRuntime', stage: 'checking', message: 'Checking the installed worker environment.' });
    const pythonExecutable = process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python');
    if (managed) {
      await runInstaller(pythonExecutable, ['-I', '-c',
        'import pathlib,platform,sys; root=pathlib.Path(sys.argv[1]).resolve(); assert sys.version_info[:3] == (3,15,0); assert platform.machine() == "arm64"; assert pathlib.Path(sys.base_prefix).resolve().is_relative_to(root)',
        env.UV_PYTHON_INSTALL_DIR], directory, env, remaining(), operation.signal);
    }
    if (request.inference) {
      await runInstaller(pythonExecutable, ['-I', '-c', 'from mflux.models.flux2.variants import Flux2KleinEdit'], directory,
        { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, remaining(), operation.signal);
    }
    const inspected = await inspectRuntime(pythonExecutable, { ...(operation.signal ? { signal: operation.signal } : {}) });
    checkSignal(operation.signal);
    return { ...inspected, directory: request.directory, dependencyLockSha256: createHash('sha256').update(lock).digest('hex') };
  } catch (cause) {
    const error = cause instanceof PicPatchUsageError || cause instanceof PicPatchRuntimeError || cause instanceof PicPatchCancelledError ? cause : new PicPatchRuntimeError('RUNTIME_SETUP', 'Could not prepare the worker environment.', { cause });
    if (owned && directory) {
      if (error instanceof PicPatchRuntimeError && error.code === 'TERMINATION_FAILED') error.recoveryDirectory = directory;
      else {
        try { await rm(directory, { recursive: true, force: true }); }
        catch (cleanup) {
          const failed = new PicPatchRuntimeError('CLEANUP_FAILED', 'Runtime setup failed and its temporary environment could not be removed.', { cause: new AggregateError([error, cleanup]) });
          failed.recoveryDirectory = directory; throw failed;
        }
      }
    }
    throw error;
  }
}
