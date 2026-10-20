import { chmod, link } from '../storage.ts';
import { syncFile } from '../platform.ts';
import { PicPatchSdkError } from '../errors.ts';
import { checkSignal } from '../operations.ts';

/** Publish only a complete synced file, exclusively, on the destination filesystem. */
export async function publishComplete(complete: string, destination: string, directory: string, signal?: AbortSignal): Promise<void> {
  try {
    await chmod(complete, 0o600);
    await syncFile(complete);
    checkSignal(signal);
    await link(complete, destination);
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
