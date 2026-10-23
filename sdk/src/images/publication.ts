import { basename, dirname, join } from 'node:path';
import { link, lstat, mkdtemp, rename, stat, storageSignal, storageWait, withoutStorageScope, writeFile } from '../storage.ts';
import { syncDirectory, syncFile } from '../platform.ts';
import { PicPatchSdkError } from '../errors.ts';
import { checkSignal } from '../operations.ts';

/** Link refusals that mean the volume has no hard links (exFAT, some network shares), not that the name is taken. */
const noHardLinks = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
type Reservation = { directory: string };
type ParentReservations = { tail: Promise<void>; active: Set<Reservation>; users: number };
const parents = new Map<string, ParentReservations>();
function conflict(): Error { return Object.assign(new Error('Destination exists.'), { code: 'EEXIST' }); }

/**
 * A private filename witness lets the destination filesystem decide equivalence, including case
 * and Unicode spelling. Lowercasing keys would incorrectly merge distinct case-sensitive files.
 * Only reservation acquisition is serialized; unrelated publications proceed independently.
 */
async function reserve(staged: string, destination: string, identity: string, signal?: AbortSignal): Promise<() => void> {
  let parent = parents.get(identity);
  if (!parent) { parent = { tail: Promise.resolve(), active: new Set(), users: 0 }; parents.set(identity, parent); }
  parent.users++;
  const previous = parent.tail;
  let unlock!: () => void;
  parent.tail = new Promise<void>(resolve => { unlock = resolve; });
  let reservation: Reservation | undefined;
  const release = () => {
    if (reservation) parent.active.delete(reservation);
    if (--parent.users === 0) parents.delete(identity);
    // The existing workspace cleanup owns the private witness too. Releasing a name must
    // never wait for optional housekeeping after its publication has already completed.
  };
  try {
    await previous;
    checkSignal(signal);
    for (const active of parent.active) {
      try { await lstat(join(active.directory, basename(destination))); throw conflict(); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
      checkSignal(signal);
    }
    const directory = await mkdtemp(join(dirname(staged), '.publication-'));
    reservation = { directory };
    checkSignal(signal);
    await writeFile(join(directory, basename(destination)), '', { flag: 'wx', mode: 0o600 });
    checkSignal(signal);
    parent.active.add(reservation);
    return release;
  } catch (cause) { release(); throw cause; }
  finally { unlock(); }
}

/**
 * Gives a complete staged file its final name without replacing anything. Hard links claim the
 * name atomically. Without them, same-process publishers reserve equivalent destination names
 * before checking absence and renaming. Another program can still take the name in that gap.
 * A reader never sees a partial file; a file is never copied into place.
 */
export async function publishFile(staged: string, destination: string, parentIdentity?: string): Promise<void> {
  const signal = storageSignal();
  // This owner outlives a caller's cancelled wait. Inner calls settle before its reservation is
  // released, and explicit checks prevent starting another filesystem operation after abort.
  await storageWait(() => withoutStorageScope(async () => {
    let release: (() => void) | undefined;
    try {
      try { await link(staged, destination); }
      catch (cause) {
        if (!noHardLinks.has((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
        checkSignal(signal);
        if (parentIdentity === undefined) {
          const parent = await stat(dirname(destination), { bigint: true });
          parentIdentity = `${parent.dev}:${parent.ino}`;
          checkSignal(signal);
        }
        release = await reserve(staged, destination, parentIdentity, signal);
        checkSignal(signal);
        try { await lstat(destination); throw conflict(); }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe; }
        checkSignal(signal);
        await rename(staged, destination);
      }
    } finally { release?.(); }
  }), destination, true);
  // Directory flushing is optional after the file's name is confirmed. Its stopped wait
  // must not replace a known completed publication with cancellation or failure.
  try { await syncDirectory(dirname(destination)); }
  catch { /* The file is already published under its name. */ }
}

/** Publish only a complete synced file, exclusively, on the destination filesystem. */
export async function publishComplete(complete: string, destination: string, directory: string, signal?: AbortSignal, parentIdentity?: string): Promise<void> {
  try {
    await syncFile(complete);
    checkSignal(signal);
    await publishFile(complete, destination, parentIdentity);
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
