import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isAbsolute } from 'node:path';
import sharp from 'sharp';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';

export interface PreparedImage {
  path: string;
  width: number;
  height: number;
  identity: string;
}
export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PicPatchCancelledError();
}

/** Copy through an open descriptor, rejecting special files before reading. */
export async function snapshotImage(source: string, target: string, signal?: AbortSignal, noFollow = false): Promise<string> {
  checkCancellation(signal);
  if (!isAbsolute(source) || source.includes('\0')) throw new PicPatchUsageError('INVALID_IMAGE', 'Image paths must be absolute.');
  let input;
  try { input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0)); }
  catch (cause) { throw new PicPatchUsageError('INVALID_IMAGE', 'Image could not be opened.', { cause }); }
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()) throw new PicPatchUsageError('INVALID_IMAGE', 'Images must be regular files.');
    const output = await open(target, 'wx', 0o600);
    try {
      await pipeline(createReadStream(source, { fd: input.fd, autoClose: false }), createWriteStream(target, { fd: output.fd, autoClose: false }), { signal });
      const after = await input.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new PicPatchUsageError('INVALID_IMAGE', 'Image changed while it was being read.');
      }
      checkCancellation(signal);
      return `${before.dev}:${before.ino}`;
    } finally { await output.close(); }
  } catch (cause) {
    if (signal?.aborted) throw new PicPatchCancelledError();
    if (cause instanceof PicPatchUsageError) throw cause;
    throw new PicPatchRuntimeError('IMAGE_IO', 'Could not snapshot the image.', { cause });
  } finally { await input.close(); }
}

/** Native sequential decode to a file; never materializes full pixels in JavaScript. */
export async function normalizeImage(snapshot: string, target: string, mask = false, signal?: AbortSignal, pngOnly = false): Promise<Omit<PreparedImage, 'identity'>> {
  checkCancellation(signal);
  try {
    const image = sharp(snapshot, { failOn: 'warning', limitInputPixels: false, sequentialRead: true });
    const metadata = await image.metadata();
    if (!(pngOnly ? ['png'] : ['png', 'jpeg', 'webp']).includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
      throw new PicPatchUsageError('INVALID_IMAGE', 'Use a single-frame PNG, JPEG, or WebP image. Outputs must be PNG.');
    }
    if (mask && (metadata.format !== 'png' || metadata.hasAlpha || metadata.space !== 'b-w')) {
      throw new PicPatchUsageError('INVALID_MASK', 'Masks must be opaque grayscale PNG images; black preserves and white edits.');
    }
    const transform = image.autoOrient();
    if (!mask) transform.toColourspace('srgb');
    const info = await transform.png().timeout({ seconds: 60 }).toFile(target);
    await chmod(target, 0o600);
    checkCancellation(signal);
    return { path: target, width: info.width, height: info.height };
  } catch (cause) {
    checkCancellation(signal);
    if (cause instanceof PicPatchCancelledError || cause instanceof PicPatchUsageError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS'].includes(code)) {
      throw new PicPatchRuntimeError('IMAGE_IO', 'Image processing could not write temporary data.', { cause });
    }
    throw new PicPatchUsageError('INVALID_IMAGE', 'Image could not be fully decoded.', { cause });
  }
}

export async function prepareImage(source: string, snapshot: string, target: string, mask = false, signal?: AbortSignal): Promise<PreparedImage> {
  const identity = await snapshotImage(source, snapshot, signal);
  const image = await normalizeImage(snapshot, target, mask, signal);
  try { await unlink(snapshot); }
  catch (cause) { throw new PicPatchRuntimeError('IMAGE_IO', 'Could not remove the input snapshot.', { cause }); }
  return { ...image, identity };
}
