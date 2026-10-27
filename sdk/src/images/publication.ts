import { basename, dirname } from 'node:path';
import { link, lstat, rename, stat, storageWait, withoutStorageScope } from '../storage.ts';
import { syncFile } from '../platform.ts';
import { PicPatchSdkError } from '../errors.ts';
import { checkSignal } from '../operations.ts';

/** Link refusals that mean the volume has no hard links (exFAT, some network shares), not that the name is taken. */
const noHardLinks = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
/** Names this process is renaming into place, keyed by parent folder and the name as a case- and normalization-insensitive volume compares it. */
const claimed = new Set<string>();
/**
 * Gives a complete file staged beside the destination its final name without replacing anything.
 * A hard link claims the name atomically. A volume without hard links gets the name by rename once
 * it is confirmed free, so a reader still never sees a partial file. This process claims the name
 * first, so its own publishers never race; the remaining gap is another program taking the same
 * name between the check and the rename. A file is never copied into place.
 */
export async function publishFile(staged: string, destination: string): Promise<void> {
  try { await link(staged, destination); }
  catch (cause) {
    if (!noHardLinks.has((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
    const parent = await stat(dirname(destination), { bigint: true });
    const key = `${parent.dev}:${parent.ino}/${basename(destination).normalize('NFC').toLowerCase()}`;
    if (claimed.has(key)) throw taken();
    claimed.add(key);
    let renaming: Promise<void> | undefined;
    try {
      try { await lstat(destination); throw taken(); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe; }
      // The rename itself runs unscoped so the claim lasts until it settles, even after the caller stops waiting.
      await storageWait(() => (renaming = withoutStorageScope(() => rename(staged, destination))), destination, true);
    } finally {
      const release = () => { claimed.delete(key); };
      if (renaming) renaming.then(release, release); else release();
    }
  }
}
function taken(): Error { return Object.assign(new Error('Destination exists.'), { code: 'EEXIST' }); }

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
