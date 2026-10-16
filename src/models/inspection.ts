import { lstat, stat, realpath, opendir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import type { LocalModelFile, ModelDiscovery, ModelInspection, ModelIssue, ModelOperationOptions } from './types.ts';

function validatePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Model locations must be absolute paths.');
  }
}
function validateOptions(options: ModelOperationOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['signal', 'onProgress'].includes(k)) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
      (options.onProgress !== undefined && typeof options.onProgress !== 'function')) {
    throw new PicPatchUsageError('INVALID_REQUEST', 'Invalid model operation options.');
  }
}
function check(options: ModelOperationOptions): void {
  if (options.signal?.aborted) throw new PicPatchCancelledError();
}
function progress(path: string, verb: 'inspectModel' | 'discoverModels', options: ModelOperationOptions): void {
  check(options);
  try { options.onProgress?.({ type: 'progress', verb, stage: 'inspecting', message: 'Inspecting local model files.', path }); }
  catch (cause) { throw new PicPatchRuntimeError('CALLBACK_FAILED', 'Model progress callback failed.', { cause }); }
  check(options);
}
/** Names identify candidates only; no file is deserialized or executed. */
function kind(path: string): LocalModelFile['kind'] | undefined {
  if (/\.(incomplete|partial|part)$/i.test(path)) return 'partial';
  if (['.safetensors', '.gguf', '.bin', '.pt', '.pth', '.ckpt'].includes(extname(path).toLowerCase())) return 'weights';
  if (['config.json', 'model_index.json'].includes(basename(path)) || path.endsWith('.index.json')) return 'configuration';
  return undefined;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
async function boundary<T>(action: () => Promise<T>, options: ModelOperationOptions): Promise<T> {
  try { return await action(); }
  catch (cause) {
    check(options);
    if (cause instanceof PicPatchUsageError || cause instanceof PicPatchRuntimeError || cause instanceof PicPatchCancelledError) throw cause;
    throw new PicPatchRuntimeError('MODEL_IO', 'Could not inspect the selected model location.', { cause });
  }
}

async function inspect(path: string, options: ModelOperationOptions, verb: 'inspectModel' | 'discoverModels'): Promise<ModelInspection> {
  progress(path, verb, options);
  const resolvedPath = await realpath(path);
  const files: LocalModelFile[] = []; const issues: ModelIssue[] = [];
  const pending = [path];
  while (pending.length) {
    check(options);
    const current = pending.pop()!;
    let info;
    try { info = await lstat(current); }
    catch (error) { if (missing(error) && current !== path) { issues.push({ path: current, code: 'MISSING_FILE' }); continue; } throw error; }
    if (info.isSymbolicLink()) {
      try { info = await stat(current); }
      catch (error) { if (missing(error)) { issues.push({ path: current, code: 'MISSING_FILE' }); continue; } throw error; }
      if (info.isDirectory() && current !== path) { issues.push({ path: current, code: 'SKIPPED_DIRECTORY_LINK' }); continue; }
    }
    if (info.isDirectory()) {
      const directory = await opendir(current);
      for await (const entry of directory) {
        check(options);
        if (entry.name !== '.git') pending.push(join(current, entry.name));
      }
    } else if (info.isFile()) {
      const category = kind(current);
      if (!category) continue;
      files.push({ path: current, resolvedPath: await realpath(current), kind: category, bytes: info.size });
      if (info.size === 0) issues.push({ path: current, code: 'EMPTY_FILE' });
      if (category === 'partial') issues.push({ path: current, code: 'PARTIAL_FILE' });
    } else if (current === path) {
      throw new PicPatchUsageError('INVALID_REQUEST', 'Select a regular model file or directory.');
    }
  }
  check(options);
  files.sort((a, b) => a.path.localeCompare(b.path)); issues.sort((a, b) => a.path.localeCompare(b.path));
  const incomplete = issues.some(issue => issue.code !== 'SKIPPED_DIRECTORY_LINK');
  return { path, resolvedPath, files, issues, status: incomplete ? 'incomplete' : files.some(f => f.kind === 'weights') ? 'unverified' : 'unrecognized', integrity: 'not-verified', compatibility: 'unknown' };
}

/** Read-only inventory. Does not parse configurations, load weights, or start a worker. */
export async function inspectModel(path: string, options: ModelOperationOptions = {}): Promise<ModelInspection> {
  validatePath(path); validateOptions(options); check(options);
  return boundary(() => inspect(normalize(path), options, 'inspectModel'), options);
}

/** Search only explicit roots; do not follow nested directory symlinks. */
export async function discoverModels(roots: string[], options: ModelOperationOptions = {}): Promise<ModelDiscovery> {
  if (!Array.isArray(roots) || roots.length === 0) throw new PicPatchUsageError('INVALID_REQUEST', 'Supply at least one model search root.');
  for (const root of roots) validatePath(root);
  validateOptions(options); check(options);
  const selected = roots.map(root => normalize(root));
  return boundary(async () => {
    const models: ModelInspection[] = []; const visited = new Set<string>();
    const pending = [...selected].reverse();
    while (pending.length) {
      check(options);
      const path = pending.pop()!;
      const resolved = await realpath(path);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      progress(path, 'discoverModels', options);
      const info = await stat(path);
      if (info.isFile()) {
        if (kind(path)) models.push(await inspect(path, options, 'discoverModels'));
        continue;
      }
      if (!info.isDirectory()) throw new PicPatchUsageError('INVALID_REQUEST', 'Select regular model files or directories.');
      const children: string[] = []; let candidate = false;
      const directory = await opendir(path);
      for await (const entry of directory) {
        check(options);
        if (entry.name === '.git') continue;
        if (entry.isDirectory()) children.push(join(path, entry.name));
        else if (kind(entry.name)) candidate = true;
      }
      if (candidate) {
        models.push(await inspect(path, options, 'discoverModels'));
        // The whole candidate is one model bundle, not one model per component.
      } else pending.push(...children.sort().reverse());
    }
    check(options);
    // Overlapping explicit roots must not return a component twice.
    const bundles = models.filter(model => !models.some(other => {
      if (other === model) return false;
      const child = relative(other.resolvedPath, model.resolvedPath);
      return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    }));
    return { models: bundles.sort((a, b) => a.path.localeCompare(b.path)) };
  }, options);
}
