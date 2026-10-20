import { storageCleanup, storageStalled } from '../../storage.ts';
import { checkProfile } from '../../profile.ts';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from '../../storage.ts';
import { join, dirname } from 'node:path';
import { resolveStoragePaths } from '../../paths.ts';
import { PicPatchSdkError } from '../../errors.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from '../../operations.ts';
import { operationStage, withDiagnostics } from '../../diagnostics.ts';
import { engineDefinition, runtimePaths, validRecord } from './identity.ts';
import { runCommand } from './command.ts';
import type { EngineIdentity, EngineInspection, EngineInstallation, EngineOptions, EngineRecord, InstallEngineOptions, ReadyEngine, PythonRuntime } from './types.ts';
import { supportsRuntime, syncDirectory, syncFile, toolEnvironment, venvPython } from '../../platform.ts';

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
function validate(options: EngineOptions, install: boolean): string {
  validateOperation(options, ['profile', 'runtime', 'engineDirectory', 'timeoutMs', ...(install ? ['uvExecutable', 'cacheDirectory', 'pythonDirectory', 'toolDirectories', 'offline'] : [])]);
  runtimePaths(options.runtime);
  const profile = options.profile === undefined ? undefined : checkProfile(options.profile);
  const engineDirectory = options.engineDirectory ?? profile?.engineDirectory;
  return resolveStoragePaths(engineDirectory === undefined ? {} : { engineDirectory }).engineDirectory;
}
/** Isolated environment for package managers/probes. No ambient credentials, config or cache selection. */
function environment(installation: string): NodeJS.ProcessEnv {
  return { ...toolEnvironment(), HOME: join(installation, 'home'), TMPDIR: join(installation, 'tmp'),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HOME: join(installation, 'home', 'huggingface') };
}
async function readReady(root: string, identity: EngineIdentity): Promise<EngineInspection> {
  const filename = join(root, 'ready', `${identity.id}.json`);
  let record: unknown;
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > 8192) return { status: 'incompatible', code: 'ENGINE_RECORD_INVALID', identity, engineDirectory: root };
    record = JSON.parse(await readFile(filename, 'utf8'));
  } catch (cause) {
    if (missing(cause)) return { status: 'missing', code: 'ENGINE_MISSING', identity, engineDirectory: root };
    if (cause instanceof SyntaxError) return { status: 'incompatible', code: 'ENGINE_RECORD_INVALID', identity, engineDirectory: root };
    throw new PicPatchSdkError('ENGINE_IO', 'Could not read engine readiness.', { cause });
  }
  if (!validRecord(record, identity)) return { status: 'incompatible', code: 'ENGINE_RECORD_INVALID', identity, engineDirectory: root };
  const pythonExecutable = venvPython(join(root, 'installations', record.installation, 'venv'));
  try { if (!(await stat(pythonExecutable)).isFile()) return { status: 'incompatible', code: 'ENGINE_CHECK_FAILED', identity, engineDirectory: root }; }
  catch (cause) {
    if (missing(cause)) return { status: 'incompatible', code: 'ENGINE_CHECK_FAILED', identity, engineDirectory: root };
    throw new PicPatchSdkError('ENGINE_IO', 'Could not read the installed interpreter.', { cause });
  }
  return { status: 'ready', code: 'ENGINE_READY', identity, engineDirectory: root, pythonExecutable };
}
async function probe(engine: ReadyEngine, signal: AbortSignal): Promise<void> {
  const { projectDirectory, probePath } = runtimePaths(engine.identity.dependencies === 'inference' ? 'mflux' : engine.identity.dependencies === 'dreamo-inference' ? 'dreamo' : 'diffusers');
  const installation = dirname(dirname(dirname(engine.pythonExecutable)));
  const result = await runCommand(engine.pythonExecutable, ['-I', '-B', probePath, join(projectDirectory, 'uv.lock')], installation, environment(installation), signal, 60_000);
  try { if (JSON.parse(result).ready !== true) throw new Error('No ready result'); }
  catch (cause) { throw new PicPatchSdkError('ENGINE_UNAVAILABLE', 'The installed runtime did not confirm its dependencies.', { cause }); }
}
async function inspect(root: string, identity: EngineIdentity, signal: AbortSignal): Promise<EngineInspection> {
  const result = await readReady(root, identity);
  checkSignal(signal);
  if (result.status !== 'ready') return result;
  try { await probe(result, signal); }
  catch (cause) {
    if (cause instanceof PicPatchSdkError && ['INSTALL_FAILED', 'ENGINE_UNAVAILABLE'].includes(cause.code)) return { status: 'incompatible', code: 'ENGINE_CHECK_FAILED', identity, engineDirectory: root };
    throw cause;
  }
  return result;
}
/** Read-only: checks actual interpreter/dependency imports; never installs or loads weights. */
export function inspectEngine(options: EngineOptions = {}): Promise<EngineInspection> {
  return withDiagnostics('inspectEngine', options, async operation => {
    const root = validate(operation, false);
    if (!supportsRuntime(operation.runtime ?? 'mflux')) return { status: 'unsupported', code: 'UNSUPPORTED_CAPABILITY', engineDirectory: root };
    return withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Engine inspection timed out.', async signal => {
      const { identity } = await engineDefinition(operation.runtime);
      operationStage(operation, 'checking', 'Checking engine dependencies.');
      return inspect(root, identity, signal);
    });
  });
}
/** Internal admission check: ordinary inference trusts preparation, without re-importing every dependency. */
export async function resolveEngine(root: string, signal?: AbortSignal, runtime: PythonRuntime = 'mflux'): Promise<ReadyEngine> {
  absolutePath(root); checkSignal(signal);
  const { identity } = await engineDefinition(runtime);
  const result = await readReady(root, identity);
  checkSignal(signal);
  if (result.status !== 'ready') throw new PicPatchSdkError(result.status === 'missing' ? 'ENGINE_MISSING' : 'ENGINE_INCOMPATIBLE', 'Install this SDK version’s engine before using the image client.', { subject: root });
  return result;
}
/** Explicit install-or-reuse. Environments stay at stable paths; only complete readiness references are replaced. */
export function installEngine(options: InstallEngineOptions): Promise<EngineInstallation> {
  return withDiagnostics('installEngine', options, async operation => {
    const root = validate(operation, true);
    absolutePath(operation.uvExecutable);
    for (const path of [operation.cacheDirectory, operation.pythonDirectory]) if (path !== undefined) absolutePath(path);
    if (operation.toolDirectories !== undefined && (!Array.isArray(operation.toolDirectories) || operation.toolDirectories.some(path => { absolutePath(path); return false; }))) throw new PicPatchSdkError('INVALID_REQUEST', 'Supply absolute build-tool directories.');
    if (operation.offline !== undefined && typeof operation.offline !== 'boolean') throw new PicPatchSdkError('INVALID_REQUEST', 'offline must be a boolean.');
    const toolDirectories = operation.toolDirectories?.slice() ?? [];
    const budget = timeBudget(operation.timeoutMs, 1_800_000);
    let completed: EngineInstallation | undefined;
    return withDeadline(operation.signal, budget, 'Engine installation timed out.', async signal => {
      const definition = await engineDefinition(operation.runtime);
      operationStage(operation, 'checking', 'Checking the installed engine.');
      const existing = await inspect(root, definition.identity, signal);
      if (existing.status === 'incompatible' && existing.code === 'ENGINE_RECORD_INVALID') throw new PicPatchSdkError('ENGINE_INCOMPATIBLE', 'Engine readiness has an unsupported or invalid format; it was preserved.', { subject: root });
      if (existing.status === 'ready') return { ...existing, origin: 'reused' as const };
      const name = `${definition.identity.id}-${randomUUID()}`;
      const installation = join(root, 'installations', name);
      const project = join(installation, 'project');
      const readyDirectory = join(root, 'ready');
      const temporary = join(readyDirectory, `${definition.identity.id}-${randomUUID()}.tmp`);
      const cache = operation.cacheDirectory ?? join(root, 'cache');
      const python = operation.pythonDirectory ?? join(root, 'python');
      let owned = false; let publicationAttempted = false;
      try {
        checkSignal(signal);
        await mkdir(dirname(installation), { recursive: true, mode: 0o700 });
        await chmod(root, 0o700);
        await chmod(dirname(installation), 0o700);
        await mkdir(installation, { mode: 0o700 }); owned = true;
        for (const directory of [project, join(installation, 'home'), join(installation, 'tmp'), readyDirectory, cache, python]) await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(project, 'pyproject.toml'), definition.manifest, { flag: 'wx', mode: 0o600 });
        await writeFile(join(project, 'uv.lock'), definition.lock, { flag: 'wx', mode: 0o600 });
        const env = { ...environment(installation), PATH: toolEnvironment(undefined, toolDirectories).PATH,
          UV_PROJECT_ENVIRONMENT: join(installation, 'venv'), UV_CACHE_DIR: cache, UV_PYTHON_INSTALL_DIR: python,
          UV_PYTHON_BIN_DIR: join(python, 'bin'), UV_PYTHON_DOWNLOADS: operation.offline ? 'never' : 'automatic', UV_NO_PROGRESS: '1', UV_HTTP_TIMEOUT: '60', UV_LINK_MODE: 'copy' };
        // Bytecode compiled once here spares every worker start from compiling imports (the worker runs with -B).
        operationStage(operation, 'installing', 'Installing locked Python dependencies.');
        await runCommand(operation.uvExecutable, ['sync', '--project', project, '--locked', '--no-default-groups', '--extra', 'inference', '--no-install-project', '--no-config', '--compile-bytecode', '--python', definition.identity.python, '--managed-python', ...(operation.offline ? ['--offline'] : [])], installation, env, signal, budget);
        const result: ReadyEngine = { status: 'ready', code: 'ENGINE_READY', identity: definition.identity, engineDirectory: root, pythonExecutable: venvPython(join(installation, 'venv')) };
        operationStage(operation, 'checking', 'Checking installed dependency compatibility.');
        await runCommand(operation.uvExecutable, ['pip', 'check', '--python', result.pythonExecutable, '--no-config', '--offline'], installation, env, signal, 60_000);
        await probe(result, signal);
        const record: EngineRecord = { version: 1, identity: definition.identity, installation: name };
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); } finally { await handle.close(); }
        operationStage(operation, 'publishing', 'Publishing the verified engine.');
        checkSignal(signal);
        publicationAttempted = true;
        await rename(temporary, join(readyDirectory, `${definition.identity.id}.json`));
        await syncDirectory(readyDirectory);
        completed = { ...result, origin: 'installed' };
        return completed;
      } catch (cause) {
        // Unconfirmed termination/publication must never trigger deletion of an environment still in use.
        let leftover = false;
        if (!storageStalled() && !publicationAttempted && !(cause instanceof PicPatchSdkError && cause.code === 'TERMINATION_FAILED')) {
          try {
            await storageCleanup(async () => { await rm(temporary, { force: true });
              if (owned) await rm(installation, { recursive: true, force: true }); });
          } catch { leftover = true; }
        }
        // The primary failure keeps its code; private files that remain are named in details.
        const error = cause instanceof PicPatchSdkError ? cause : new PicPatchSdkError('ENGINE_IO', 'Could not prepare or publish the engine.', { cause });
        if (leftover) error.details.recoveryDirectory = installation;
        if (storageStalled() || publicationAttempted || error.code === 'TERMINATION_FAILED') { error.details.recoveryDirectory = installation; error.effect = 'unknown'; }
        throw error;
      }
    }).catch(error => { if (completed) return completed; throw error; });
  });
}
