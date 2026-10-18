import { storageWait } from '../storage.ts';
import type { ImageFingerprint } from './fingerprint.ts';
import { unlink } from '../storage.ts';
import { join } from 'node:path';
import sharp from 'sharp';
import { PicPatchSdkError } from '../errors.ts';
import type { ImageSize } from '../types.ts';
import { checkCancellation, normalizeImage, snapshotImage } from './validation.ts';

/** A control map describes the output coordinate system; never silently crop or resize it. */
export async function prepareControl(image: string, directory: string, size: ImageSize, signal?: AbortSignal, expected?: ImageFingerprint, measured?: (fingerprint: ImageFingerprint) => void) {
  const snapshot = join(directory, 'control.tmp'); const target = join(directory, 'control.png');
  await snapshotImage(image, snapshot, signal, false, expected, measured);
  try {
    const metadata = await storageWait(() => sharp(snapshot, { limitInputPixels: false, sequentialRead: true }).metadata(), snapshot);
    if (metadata.format !== 'png' || metadata.hasAlpha) throw new PicPatchSdkError('INVALID_IMAGE', 'Control maps must be opaque PNG images.');
    // Normalize grayscale maps to RGB as required by the three-channel ControlNet hint encoder.
    const prepared = await normalizeImage(snapshot, target, false, signal, true);
    if (prepared.width !== size.width || prepared.height !== size.height) throw new PicPatchSdkError('INVALID_REQUEST', 'Control map dimensions must match output dimensions after orientation.');
    try { await unlink(snapshot); }
    catch (cause) { throw new PicPatchSdkError('IMAGE_IO', 'Could not remove the control snapshot.', { cause }); }
    return prepared;
  } catch (cause) {
    checkCancellation(signal);
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('INVALID_IMAGE', 'Could not prepare the control map.', { cause });
  }
}
