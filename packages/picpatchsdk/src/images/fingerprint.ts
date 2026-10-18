import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal } from '../operations.ts';

/** SHA-256 of original encoded file bytes, not normalized pixels or a path string. */
export interface ImageFingerprint { bytes: number; sha256: string }
export async function inspectImage(path: string, signal?: AbortSignal) {
  absolutePath(path); checkSignal(signal);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new PicPatchSdkError('INVALID_IMAGE', 'Images must be regular files.', { subject: path });
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) })) {
      checkSignal(signal); hash.update(chunk); bytes += chunk.length;
    }
    checkSignal(signal);
    let metadata;
    try { metadata = await sharp(path, { failOn: 'warning', limitInputPixels: false, sequentialRead: true }).metadata(); }
    catch (cause) { throw new PicPatchSdkError('INVALID_IMAGE', 'Image headers could not be decoded.', { cause, subject: path }); }
    const after = await stat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes) !== before.size) throw new PicPatchSdkError('INPUTS_CHANGED', 'Image changed while planning.', { subject: path });
    checkSignal(signal);
    return { fingerprint: { bytes, sha256: hash.digest('hex') }, metadata, identity: `${before.dev}:${before.ino}` };
  } catch (cause) {
    checkSignal(signal);
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('IMAGE_IO', 'Could not inspect the image.', { cause, subject: path });
  } finally { await file?.close(); }
}
