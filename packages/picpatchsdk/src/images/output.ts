import { prepareControl } from './control.ts';
import { prepareOutpaint } from './outpaint.ts';
import { publishSidecar } from './sidecar.ts';
import { basename, dirname, join } from 'node:path';
import { chmod, link, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { PicPatchSdkError } from '../errors.ts';
import type { ImageRequest, EditResult, InputGeometry, ModelCapabilities } from '../types.ts';
import type { GeometryPolicy } from './geometry.ts';
import { checkCancellation, normalizeImage, prepareImage, snapshotImage } from './validation.ts';

/** An operation owns only this private directory, never the caller's source/output files. */
export class ImageWorkspace<T extends ImageRequest = ImageRequest> {
  readonly directory: string;
  readonly workerRequest: T & Pick<ImageRequest, 'size'>;
  private readonly request: T;
  private readonly destination: string;
  private retain = false;
  private readonly geometry: InputGeometry[] = [];
  private outpaint: EditResult['outpaint'];
  private constructor(directory: string, destination: string, request: T) {
    this.directory = directory; this.destination = destination; this.request = request;
    this.workerRequest = { ...structuredClone(request), outputPath: join(directory, 'worker.png') };
    // Artifact retention belongs to this process, never to an inference runtime.
    delete this.workerRequest.sidecar;
  }

  static async create<T extends ImageRequest>(request: T, signal?: AbortSignal): Promise<ImageWorkspace<T>> {
    checkCancellation(signal);
    let parent: string;
    try { parent = await realpath(dirname(request.outputPath)); }
    catch (cause) { throw new PicPatchSdkError('OUTPUT_IO', 'Output directory must already exist and be accessible.', { cause, subject: dirname(request.outputPath) }); }
    const destination = join(parent, basename(request.outputPath));
    for (const path of request.sidecar ? [destination, `${destination}.json`] : [destination]) {
      try {
        await lstat(path);
        throw new PicPatchSdkError('OUTPUT_CONFLICT', 'Output already exists; choose a new path.');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (cause instanceof PicPatchSdkError) throw cause;
          throw new PicPatchSdkError('OUTPUT_IO', 'Could not inspect the output destination.', { cause });
        }
      }
    }
    try {
      const directory = await mkdtemp(join(parent, '.picpatch-'));
      return new ImageWorkspace(directory, destination, structuredClone(request));
    } catch (cause) { throw new PicPatchSdkError('OUTPUT_IO', 'Could not create private output storage.', { cause }); }
  }

  async prepare(signal?: AbortSignal, policy?: GeometryPolicy, maskMode: ModelCapabilities['maskMode'] = 'composite', defaultSize?: ModelCapabilities['defaultOutputSize']): Promise<void> {
    if (this.request.control) {
      const size = this.request.size ?? defaultSize;
      if (!size) throw new PicPatchSdkError('INVALID_REQUEST', 'Control maps require output dimensions.');
      const prepared = await prepareControl(this.request.control.image, this.directory, size, signal);
      this.workerRequest.control = { ...this.request.control, image: prepared.path };
      this.workerRequest.size = size;
      this.geometry.push({ path: this.request.control.image, ...prepared.geometry });
    }
    if (!('instruction' in this.request) || !('instruction' in this.workerRequest)) { checkCancellation(signal); return; }
    let index = 0;
    const prepare = async (path: string, mask = false, preserveSize = false) => {
      const stem = join(this.directory, `input-${index++}`);
      const image = await prepareImage(path, `${stem}.tmp`, `${stem}.png`, mask, signal, mask || preserveSize ? undefined : policy);
      this.geometry.push({ path, ...image.geometry });
      return image;
    };
    const source = this.request.sourceImage ? await prepare(this.request.sourceImage, false, this.request.outpaint !== undefined) : undefined;
    if (source) this.workerRequest.sourceImage = source.path;
    if (this.request.outpaint && source) {
      const prepared = await prepareOutpaint(source, this.request.outpaint, this.directory, signal);
      this.workerRequest.sourceImage = prepared.sourceImage;
      this.workerRequest.maskImage = prepared.maskImage;
      this.workerRequest.size = this.request.outpaint.size;
      delete this.workerRequest.outpaint;
      this.outpaint = { ...this.request.outpaint, sourceSize: { width: source.width, height: source.height } };
    }
    if (this.request.maskImage) {
      if (!source || source.width !== source.geometry.orientedSize.width || source.height !== source.geometry.orientedSize.height) {
        throw new PicPatchSdkError('INVALID_MASK', 'Masked editing requires source dimensions that need no model resizing or cropping.');
      }
      if (maskMode !== 'native' && this.request.size && (this.request.size.width !== source.width || this.request.size.height !== source.height)) {
        throw new PicPatchSdkError('INVALID_MASK', 'Masked output dimensions must match the oriented source.');
      }
      this.workerRequest.size = this.request.size ?? { width: source.width, height: source.height };
      const mask = await prepare(this.request.maskImage, true);
      if (!source || mask.width !== source.width || mask.height !== source.height) {
        throw new PicPatchSdkError('INVALID_MASK', 'Mask dimensions must match the oriented source image.');
      }
      this.workerRequest.maskImage = mask.path;
    }
    const identities = new Set<string>();
    for (const group of this.workerRequest.references ?? []) {
      for (let i = 0; i < group.images.length; i++) {
        const image = await prepare(group.images[i]!);
        if (identities.has(image.identity)) throw new PicPatchSdkError('INVALID_IMAGE', 'Reference images must not alias the same file.');
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
      throw new PicPatchSdkError('INVALID_OUTPUT', 'Worker output is missing, malformed, or inconsistent with its metadata.', { cause });
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
      if ((cause instanceof PicPatchSdkError && cause.kind === 'cancelled')) throw cause;
      this.retain = true;
      const error = (cause as NodeJS.ErrnoException).code === 'EEXIST'
        ? new PicPatchSdkError('OUTPUT_CONFLICT', 'Output appeared during the operation; the completed image was retained.', { cause })
        : new PicPatchSdkError('OUTPUT_IO', 'Could not publish atomically; the completed image was retained.', { cause });
      error.details.recoveryDirectory = this.directory;
      error.effect = 'unknown';
      throw error;
    }
    // Publication is the commit point. A later abort must not disguise a saved result.
    const { sidecar: _runtimeSidecar, outpaint: _runtimeCanvas, ...response } = result;
    const saved: EditResult = { ...response, image: { ...result.image, path: this.request.outputPath }, references: structuredClone('instruction' in this.request ? this.request.references ?? [] : []), inputGeometry: structuredClone(this.geometry) };
    if (this.outpaint) saved.outpaint = structuredClone(this.outpaint);
    if (this.request.sidecar) saved.sidecar = await publishSidecar(this.request, saved, complete, `${this.destination}.json`, this.directory);
    return saved;
  }

  preserve(): void { this.retain = true; }
  async cleanup(): Promise<void> {
    if (!this.retain) await rm(this.directory, { recursive: true, force: true });
  }
}
