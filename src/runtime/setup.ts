import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { absolutePath, checkSignal, emitProgress, timeBudget, validateOperation } from '../operations.ts';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import { inspectRuntime } from './inspection.ts';
import { runInstaller } from './command.ts';
import type { RuntimeOperationOptions, RuntimeSetupRequest, RuntimeSetupResult } from './types.ts';

/** Explicit setup installs only locked worker packages, never Python or model weights. */
export async function setupRuntime(input: RuntimeSetupRequest, options: RuntimeOperationOptions = {}): Promise<RuntimeSetupResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['directory', 'pythonExecutable', 'uvExecutable', 'offline', 'cacheDirectory'].includes(k))) throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid runtime setup request.');
  for (const path of [input.directory, input.pythonExecutable, input.uvExecutable]) absolutePath(path);
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
    emitProgress(operation, { type: 'progress', verb: 'setupRuntime', stage: 'installing', message: 'Installing locked worker dependencies.' });
    await runInstaller(request.uvExecutable, ['sync', '--project', project, '--python', request.pythonExecutable, '--no-python-downloads', '--no-dev', '--no-install-project', '--locked', '--no-config', '--no-build', '--link-mode', 'copy', '--cache-dir', cache, ...(request.offline ? ['--offline'] : [])], directory, env, budget, operation.signal);
    checkSignal(operation.signal);
    emitProgress(operation, { type: 'progress', verb: 'setupRuntime', stage: 'checking', message: 'Checking the installed worker environment.' });
    const pythonExecutable = process.platform === 'win32' ? join(environment, 'Scripts', 'python.exe') : join(environment, 'bin', 'python');
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
