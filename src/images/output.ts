import { basename, dirname, join } from 'node:path';
import { chmod, link, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { PicPatchCancelledError, PicPatchRuntimeError, PicPatchUsageError } from '../errors.ts';
import type { EditRequest, EditResult, InputGeometry } from '../types.ts';
import type { GeometryPolicy } from './geometry.ts';
import { checkCancellation, normalizeImage, prepareImage, snapshotImage } from './validation.ts';

/** An operation owns only this private directory, never the caller's source/output files. */
export class ImageWorkspace {
  readonly directory: string;
  readonly workerRequest: EditRequest;
  private readonly request: EditRequest;
  private readonly destination: string;
  private retain = false;
  private readonly geometry: InputGeometry[] = [];
  private constructor(directory: string, destination: string, request: EditRequest) {
    this.directory = directory; this.destination = destination; this.request = request;
    this.workerRequest = { ...structuredClone(request), outputPath: join(directory, 'worker.png') };
  }

  static async create(request: EditRequest, signal?: AbortSignal): Promise<ImageWorkspace> {
    checkCancellation(signal);
    let parent: string;
    try { parent = await realpath(dirname(request.outputPath)); }
    catch (cause) { throw new PicPatchUsageError('INVALID_REQUEST', 'Output directory must already exist and be accessible.', { cause }); }
    const destination = join(parent, basename(request.outputPath));
    try {
      await lstat(destination);
      throw new PicPatchUsageError('OUTPUT_CONFLICT', 'Output already exists; choose a new path.');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (cause instanceof PicPatchUsageError) throw cause;
        throw new PicPatchRuntimeError('OUTPUT_IO', 'Could not inspect the output destination.', { cause });
      }
    }
    try {
      const directory = await mkdtemp(join(parent, '.picpatch-'));
      return new ImageWorkspace(directory, destination, structuredClone(request));
    } catch (cause) { throw new PicPatchRuntimeError('OUTPUT_IO', 'Could not create private output storage.', { cause }); }
  }

  async prepare(signal?: AbortSignal, policy?: GeometryPolicy): Promise<void> {
    let index = 0;
    const prepare = async (path: string, mask = false) => {
      const stem = join(this.directory, `input-${index++}`);
      const image = await prepareImage(path, `${stem}.tmp`, `${stem}.png`, mask, signal, mask ? undefined : policy);
      this.geometry.push({ path, ...image.geometry });
      return image;
    };
    const source = this.request.sourceImage ? await prepare(this.request.sourceImage) : undefined;
    if (source) this.workerRequest.sourceImage = source.path;
    if (this.request.maskImage) {
      if (!source || source.width !== source.geometry.orientedSize.width || source.height !== source.geometry.orientedSize.height) {
        throw new PicPatchUsageError('INVALID_MASK', 'Masked editing requires source dimensions that need no model resizing or cropping.');
      }
      if (this.request.size && (this.request.size.width !== source.width || this.request.size.height !== source.height)) {
        throw new PicPatchUsageError('INVALID_MASK', 'Masked output dimensions must match the oriented source.');
      }
      this.workerRequest.size = { width: source.width, height: source.height };
      const mask = await prepare(this.request.maskImage, true);
      if (!source || mask.width !== source.width || mask.height !== source.height) {
        throw new PicPatchUsageError('INVALID_MASK', 'Mask dimensions must match the oriented source image.');
      }
      this.workerRequest.maskImage = mask.path;
    }
    const identities = new Set<string>();
    for (const group of this.workerRequest.references ?? []) {
      for (let i = 0; i < group.images.length; i++) {
        const image = await prepare(group.images[i]!);
        if (identities.has(image.identity)) throw new PicPatchUsageError('INVALID_IMAGE', 'Reference images must not alias the same file.');
        identities.add(image.identity);
        group.images[i] = image.path;
      }
    }
    checkCancellation(signal);
  }

  async publish(result: EditResult, signal?: AbortSignal): Promise<EditResult> {
    checkCancellation(signal);
    const snapshot = join(this.directory, 'result.tmp');
    const complete = join(this.directory, 'complete.png');
    try {
      if (result.image.path !== this.workerRequest.outputPath || result.model !== this.request.model) {
        throw new Error('Worker returned an unexpected artifact.');
      }
      // Reject symlinks and decode an independent copy of the worker's finished file.
      await snapshotImage(this.workerRequest.outputPath, snapshot, signal, true);
      const image = await normalizeImage(snapshot, complete, false, signal, true);
      if (image.width !== result.image.size.width || image.height !== result.image.size.height ||
          (this.workerRequest.size && (image.width !== this.workerRequest.size.width || image.height !== this.workerRequest.size.height))) {
        throw new Error('Output dimensions do not match the result or requested size.');
      }
    } catch (cause) {
      checkCancellation(signal);
      throw new PicPatchRuntimeError('INVALID_OUTPUT', 'Worker output is missing, malformed, or inconsistent with its metadata.', { cause });
    }
    checkCancellation(signal);
    try {
      await chmod(complete, 0o600);
      const file = await open(complete, 'r');
      try { await file.sync(); } finally { await file.close(); }
      checkCancellation(signal);
      // A hard link atomically publishes a complete file and fails if any entry already exists.
      // No overwriting rename or copy fallback is permitted.
      await link(complete, this.destination);
    } catch (cause) {
      if (cause instanceof PicPatchCancelledError) throw cause;
      this.retain = true;
      const error = (cause as NodeJS.ErrnoException).code === 'EEXIST'
        ? new PicPatchUsageError('OUTPUT_CONFLICT', 'Output appeared during the edit; the completed image was retained.', { cause })
        : new PicPatchRuntimeError('OUTPUT_IO', 'Could not publish atomically; the completed image was retained.', { cause });
      error.recoveryDirectory = this.directory;
      throw error;
    }
    // Publication is the commit point. A later abort must not disguise a saved result.
    return { ...result, image: { ...result.image, path: this.request.outputPath }, references: structuredClone(this.request.references ?? []), inputGeometry: structuredClone(this.geometry) };
  }

  preserve(): void { this.retain = true; }
  async cleanup(): Promise<void> {
    if (!this.retain) await rm(this.directory, { recursive: true, force: true });
  }
}
