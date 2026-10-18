import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { ImageFingerprint } from './fingerprint.ts';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isAbsolute } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { inputGeometry, type GeometryPolicy } from './geometry.ts';
import type { InputGeometry } from '../types.ts';
import { PicPatchSdkError } from '../errors.ts';

export interface PreparedImage {
  path: string;
  width: number;
  height: number;
  identity: string;
  geometry: Omit<InputGeometry, 'path'>;
}
export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PicPatchSdkError('CANCELLED', 'The operation was cancelled.');
}

/** Copy through an open descriptor, rejecting special files before reading. */
export async function snapshotImage(source: string, target: string, signal?: AbortSignal, noFollow = false, expected?: ImageFingerprint): Promise<string> {
  checkCancellation(signal);
  if (!isAbsolute(source) || source.includes('\0')) throw new PicPatchSdkError('INVALID_IMAGE', 'Image paths must be absolute.');
  let input;
  try { input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0)); }
  catch (cause) {
    if (expected && ['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw new PicPatchSdkError('INPUTS_CHANGED', 'Planned input is missing.', { subject: source });
    throw new PicPatchSdkError('IMAGE_IO', 'Image could not be opened.', { cause, subject: source });
  }
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile()) throw new PicPatchSdkError(expected ? 'INPUTS_CHANGED' : 'INVALID_IMAGE', 'Images must be regular files.', { subject: source });
    const output = await open(target, 'wx', 0o600);
    try {
      const hash = expected ? createHash('sha256') : undefined;
      let bytes = 0;
      const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash?.update(chunk); bytes += chunk.length; callback(null, chunk); } });
      await pipeline(createReadStream(source, { fd: input.fd, autoClose: false }), measure, createWriteStream(target, { fd: output.fd, autoClose: false }), { signal });
      if (expected && (bytes !== expected.bytes || hash!.digest('hex') !== expected.sha256)) throw new PicPatchSdkError('INPUTS_CHANGED', 'Input content differs from the accepted plan.', { subject: source });
      const after = await input.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new PicPatchSdkError(expected ? 'INPUTS_CHANGED' : 'INVALID_IMAGE', 'Image changed while it was being read.', { subject: source });
      }
      checkCancellation(signal);
      return `${before.dev}:${before.ino}`;
    } finally { await output.close(); }
  } catch (cause) {
    if (signal?.aborted) throw new PicPatchSdkError('CANCELLED', 'The operation was cancelled.');
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('IMAGE_IO', 'Could not snapshot the image.', { cause });
  } finally { await input.close(); }
}

/** Native sequential decode to a file; never materializes full pixels in JavaScript. */
export async function normalizeImage(snapshot: string, target: string, mask = false, signal?: AbortSignal, pngOnly = false, policy?: GeometryPolicy): Promise<Omit<PreparedImage, 'identity'>> {
  checkCancellation(signal);
  try {
    const image = sharp(snapshot, { failOn: 'warning', limitInputPixels: false, sequentialRead: true });
    const metadata = await image.metadata();
    validateImageMetadata(metadata, mask, pngOnly);
    if (mask && policy) throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'This geometry policy does not support masks.');
    const geometry = inputGeometry(metadata.width, metadata.height, metadata.orientation, policy);
    const transform = image.autoOrient();
    const { orientedSize, scaledSize, preparedSize, crop } = geometry;
    if (scaledSize.width !== orientedSize.width || scaledSize.height !== orientedSize.height) {
      transform.resize(scaledSize.width, scaledSize.height, { fit: 'fill', kernel: 'lanczos3' });
    }
    if (preparedSize.width !== scaledSize.width || preparedSize.height !== scaledSize.height) {
      transform.extract({ ...crop, width: preparedSize.width, height: preparedSize.height });
    }
    transform.toColourspace(mask ? 'b-w' : 'srgb');
    const info = await transform.png().timeout({ seconds: 60 }).toFile(target);
    await chmod(target, 0o600);
    checkCancellation(signal);
    if (info.width !== geometry.preparedSize.width || info.height !== geometry.preparedSize.height) throw new PicPatchSdkError('INVALID_IMAGE', 'Prepared dimensions do not match the model geometry.');
    return { path: target, width: info.width, height: info.height, geometry };
  } catch (cause) {
    checkCancellation(signal);
    if (cause instanceof PicPatchSdkError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS'].includes(code)) {
      throw new PicPatchSdkError('IMAGE_IO', 'Image processing could not write temporary data.', { cause });
    }
    throw new PicPatchSdkError('INVALID_IMAGE', 'Image could not be fully decoded.', { cause });
  }
}

export async function prepareImage(source: string, snapshot: string, target: string, mask = false, signal?: AbortSignal, policy?: GeometryPolicy, expected?: ImageFingerprint): Promise<PreparedImage> {
  const identity = await snapshotImage(source, snapshot, signal, false, expected);
  const image = await normalizeImage(snapshot, target, mask, signal, false, policy);
  try { await unlink(snapshot); }
  catch (cause) { throw new PicPatchSdkError('IMAGE_IO', 'Could not remove the input snapshot.', { cause }); }
  return { ...image, identity };
}

/** Shared admission for header-only planning and full decode at execution. */
export function validateImageMetadata(metadata: Metadata, mask = false, pngOnly = false): void {
  if (!(pngOnly ? ['png'] : ['png', 'jpeg', 'webp']).includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
    throw new PicPatchSdkError('INVALID_IMAGE', 'Use a single-frame PNG, JPEG, or WebP image. Outputs must be PNG.');
  }
  if (mask && (metadata.format !== 'png' || metadata.hasAlpha || metadata.space !== 'b-w')) {
    throw new PicPatchSdkError('INVALID_MASK', 'Masks must be opaque grayscale PNG images; black preserves and white edits.');
  }
}
