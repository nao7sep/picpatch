import { dirname } from 'node:path';
import { link, lstat, rename } from '../storage.ts';
import { syncDirectory, syncFile } from '../platform.ts';
import { PicPatchSdkError } from '../errors.ts';
import { checkSignal } from '../operations.ts';

/** Link refusals that mean the volume has no hard links (exFAT, some network shares), not that the name is taken. */
const noHardLinks = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
/**
 * Gives a complete file staged beside the destination its final name without replacing anything.
 * A hard link claims the name atomically. A volume without hard links gets the name by rename once
 * it is confirmed free, so a reader still never sees a partial file; the remaining gap is another
 * writer taking the same name between the check and the rename. A file is never copied into place.
 * The folder is then flushed so the new name survives a crash; a flush the volume refuses does not undo publication.
 */
export async function publishFile(staged: string, destination: string): Promise<void> {
  try { await link(staged, destination); }
  catch (cause) {
    if (!noHardLinks.has((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
    try { await lstat(destination); throw Object.assign(new Error('Destination exists.'), { code: 'EEXIST' }); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe; }
    await rename(staged, destination);
  }
  try { await syncDirectory(dirname(destination)); }
  catch { /* The file is already published under its name. */ }
}

/** Publish only a complete synced file, exclusively, on the destination filesystem. */
export async function publishComplete(complete: string, destination: string, directory: string, signal?: AbortSignal): Promise<void> {
  try {
    await syncFile(complete);
    checkSignal(signal);
    await publishFile(complete, destination);
  } catch (cause) {
    if (cause instanceof PicPatchSdkError && cause.kind === 'cancelled') throw cause;
    const error = (cause as NodeJS.ErrnoException).code === 'EEXIST'
      ? new PicPatchSdkError('OUTPUT_CONFLICT', 'Output appeared during the operation; the completed image was retained.', { cause, subject: destination })
      : new PicPatchSdkError('OUTPUT_IO', 'Could not publish atomically; the completed image was retained.', { cause, subject: destination });
    error.details.recoveryDirectory = directory;
    error.effect = 'unknown';
    throw error;
  }
}
