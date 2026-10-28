import { join } from 'node:path';
import { lstat, realpath, opendir, mkdtemp, rename, rm } from '../storage.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { checkSignal, withSettings } from '../operations.ts';
import { PicPatchSdkError } from '../errors.ts';
import { resolveStoragePaths } from '../paths.ts';
import { checkProfile } from '../profile.ts';
import { catalogModel } from './catalog.ts';
import type { ModelStoreSettings } from './opening.ts';
import type { CallOptions } from '../types.ts';

export type { ManagedModelEntry } from './types.ts';
import type { ManagedModelEntry } from './types.ts';
const entryKind = (name: string): ManagedModelEntry['kind'] | undefined => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(name) ? 'revision' : /^\.(?:prepare|remove)-[A-Za-z0-9]+$/.test(name) ? 'incomplete' : undefined;
const absent = (cause: unknown) => ['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '');
export function managedRoot(options: ModelStoreSettings): string {
  const profile = options.profile === undefined ? undefined : checkProfile(options.profile);
  const modelsDirectory = options.modelsDirectory ?? profile?.modelsDirectory;
  return resolveStoragePaths(modelsDirectory === undefined ? {} : { modelsDirectory }).modelsDirectory;
}
async function parentDirectory(root: string, id: string): Promise<string> {
  const resolved = await realpath(root);
  const parent = join(resolved, id);
  if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent) throw new PicPatchSdkError('MODEL_LINK_REFUSED', 'Managed model directories cannot be links.', { subject: parent });
  return parent;
}
async function size(directory: string, signal?: AbortSignal): Promise<number> {
  let bytes = 0; const pending = [directory];
  while (pending.length) {
    checkSignal(signal);
    const path = pending.pop()!; const info = await lstat(path);
    if (info.isFile()) bytes += info.size;
    else if (info.isDirectory()) {
      for await (const entry of await opendir(path)) pending.push(join(path, entry.name));
    }
  }
  return bytes;
}
/** Only names created by catalog acquisition are managed; arbitrary directories stay caller-owned. */
export async function managedEntries(root: string, modelId: string, revision: string, signal?: AbortSignal): Promise<ManagedModelEntry[]> {
  let parent: string;
  try { parent = await parentDirectory(root, modelId); } catch (cause) { if (absent(cause)) return []; throw cause; }
  const entries: ManagedModelEntry[] = [];
  for await (const entry of await opendir(parent)) {
    checkSignal(signal);
    const kind = entryKind(entry.name);
    if (!kind || !entry.isDirectory()) continue;
    const directory = join(parent, entry.name);
    entries.push({ modelId, name: entry.name, directory, kind, current: entry.name === revision, bytes: await size(directory, signal) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
export type RemoveModelResult = { status: 'removed' | 'missing'; modelId: string; name: string; directory: string };
/** Explicit deletion of one managed revision/attempt. Dispose editors and settle installs using it first.
 * Other processes are not coordinated: a concurrent user may fail visibly, never gain partial ready weights.
 * Symlink targets and caller-owned external bundles are never traversed.
 */
export function removeModel(modelId: string, name: string, settings: ModelStoreSettings = {}, options: CallOptions = {}): Promise<RemoveModelResult> {
  return withDiagnostics('removeModel', options, async call => {
    const operation = withSettings(settings, ['profile', 'modelsDirectory'], call);
    const model = catalogModel(modelId);
    if (model.acquisition !== 'pinned' || typeof name !== 'string' || !entryKind(name)) throw new PicPatchSdkError('INVALID_REQUEST', 'Select one managed revision or incomplete attempt from inventory.');
    const root = managedRoot(operation);
    let removed: RemoveModelResult | undefined;
    try {
      const signal = operation.signal;
      checkSignal(signal);
      const directory = join(root, modelId, name);
      let parent: string, before;
      try { parent = await parentDirectory(root, modelId); before = await lstat(join(parent, name), { bigint: true }); }
      catch (cause) { if (absent(cause)) return { status: 'missing' as const, modelId, name, directory }; throw cause; }
      if (!before.isDirectory() || before.isSymbolicLink()) throw new PicPatchSdkError('INVALID_REQUEST', 'Only managed directories can be removed.', { subject: directory });
      checkSignal(signal);
      const recovery = await mkdtemp(join(parent, '.remove-'));
      try {
        // Detach the selected directory before deletion; never delete a replacement installed at its old name.
        const detached = join(recovery, 'model');
        await rename(join(parent, name), detached);
        const actual = await lstat(detached, { bigint: true });
        if (actual.dev !== before.dev || actual.ino !== before.ino) throw new PicPatchSdkError('MODEL_CHANGED', 'Model directory changed before removal.', { subject: directory });
        checkSignal(signal);
        await rm(recovery, { recursive: true, force: true });
        removed = { status: 'removed', modelId, name, directory };
        return removed;
      } catch (cause) {
        if (cause instanceof PicPatchSdkError) {
          cause.effect = 'unknown'; cause.details.recoveryDirectory = recovery;
          throw cause;
        }
        throw new PicPatchSdkError('MODEL_REMOVAL_INCOMPLETE', 'Model removal was not completed; inspect retained files.', { cause, effect: 'unknown', subject: directory, details: { recoveryDirectory: recovery } });
      }
    } catch (cause) {
      if (removed) return removed;
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('MODEL_IO', 'Could not remove the selected model.', { cause });
    }
  });
}
