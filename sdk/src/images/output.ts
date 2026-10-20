import { publishComplete } from './publication.ts';
import { storageRecovery, storageCleanup } from '../storage.ts';
import type { ArtifactRecord } from '../contracts.generated.ts';
import type { ImageResult } from '../types.ts';
import type { ImagePlan } from './planning.ts';
import { prepareControl } from './control.ts';
import { prepareOutpaint } from './outpaint.ts';
import { createArtifactRecord, publishSidecar, sidecarPath } from './sidecar.ts';
import { finishImage, sourceMetadata } from './metadata.ts';
import { basename, dirname, join } from 'node:path';
import { lstat, mkdtemp, realpath, rm, stat } from '../storage.ts';
import { PicPatchSdkError } from '../errors.ts';
import type { ImageRequest, InputGeometry, ModelCapabilities } from '../types.ts';
import type { EditResult } from '../contracts.generated.ts';
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
  private readonly fingerprints: ArtifactRecord['fingerprints'] = [];
  private outpaint: EditResult['outpaint'];
  /** The private snapshot of an edit's source image, whose metadata its output carries. */
  private source: string | undefined;
  private maskMode: EditResult['maskMode'];
  private constructor(directory: string, destination: string, request: T) {
    storageRecovery(directory);
    this.directory = directory; this.destination = destination; this.request = request;
    this.workerRequest = { ...structuredClone(request), outputPath: join(directory, 'worker.png') };
    // Record content and sidecar publication belong to this process, never to an inference runtime.
    delete this.workerRequest.sidecar;
    delete this.workerRequest.record;
  }

  static async create<T extends ImageRequest>(request: T, signal?: AbortSignal, plan?: ImagePlan): Promise<ImageWorkspace<T>> {
    let location;
    try { location = await inspectDestination(request, signal); }
    catch (cause) {
      if (plan && cause instanceof PicPatchSdkError && cause.code === 'FILE_NOT_FOUND') throw new PicPatchSdkError('DESTINATION_CHANGED', 'The planned output directory is missing.', { subject: request.outputPath });
      throw cause;
    }
    if (plan && (location.path !== plan.destination.path || location.identity !== plan.destination.identity)) throw new PicPatchSdkError('DESTINATION_CHANGED', 'The planned output directory changed.', { subject: request.outputPath });
    const destination = location.path;
    const parent = dirname(destination);
    try {
      const directory = await mkdtemp(join(parent, '.picpatch-'));
      return new ImageWorkspace(directory, destination, structuredClone(request));
    } catch (cause) { throw new PicPatchSdkError('OUTPUT_IO', 'Could not create private output storage.', { cause }); }
  }

  async prepare(signal?: AbortSignal, policy?: GeometryPolicy, maskMode: ModelCapabilities['maskMode'] = 'composite', defaultSize?: ModelCapabilities['defaultOutputSize'], plan?: ImagePlan): Promise<void> {
    const expected = (path: string) => plan?.inputs.find(input => input.path === path)?.fingerprint;
    if (this.request.control) {
      const size = this.request.size ?? defaultSize;
      if (!size) throw new PicPatchSdkError('INVALID_REQUEST', 'Control maps require output dimensions.');
      const prepared = await prepareControl(this.request.control.image, this.directory, size, signal, expected(this.request.control.image), fingerprint => this.fingerprints.push({ role: 'control', ...fingerprint }));
      this.workerRequest.control = { ...this.request.control, image: prepared.path };
      this.workerRequest.size = size;
      this.geometry.push({ path: this.request.control.image, ...prepared.geometry });
    }
    if (!('instruction' in this.request) || !('instruction' in this.workerRequest)) { checkCancellation(signal); return; }
    let index = 0;
    const prepare = async (path: string, role: ArtifactRecord['fingerprints'][number]['role'], mask = false, preserveSize = false) => {
      const stem = join(this.directory, `input-${index++}`);
      const image = await prepareImage(path, `${stem}.tmp`, `${stem}.png`, mask, signal, mask || preserveSize ? undefined : policy, expected(path), fingerprint => this.fingerprints.push({ role, ...fingerprint }), role === 'source');
      if (role === 'source') this.source = `${stem}.tmp`;
      this.geometry.push({ path, ...image.geometry });
      return image;
    };
    const source = this.request.sourceImage ? await prepare(this.request.sourceImage, 'source', false, this.request.outpaint !== undefined) : undefined;
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
      const mask = await prepare(this.request.maskImage, 'mask', true);
      if (!source || mask.width !== source.width || mask.height !== source.height) {
        throw new PicPatchSdkError('INVALID_MASK', 'Mask dimensions must match the oriented source image.');
      }
      this.workerRequest.maskImage = mask.path;
    }
    if ('maskImage' in this.workerRequest && this.workerRequest.maskImage && maskMode !== 'none') this.maskMode = maskMode;
    const identities = new Set<string>();
    for (const group of this.workerRequest.references ?? []) {
      for (let i = 0; i < group.images.length; i++) {
        const image = await prepare(group.images[i]!, 'reference');
        if (identities.has(image.identity)) throw new PicPatchSdkError('INVALID_IMAGE', 'Reference images must not alias the same file.');
        identities.add(image.identity);
        group.images[i] = image.path;
      }
    }
    checkCancellation(signal);
  }

  async publish(result: EditResult, signal?: AbortSignal): Promise<ImageResult> {
    checkCancellation(signal);
    const snapshot = join(this.directory, 'result.tmp');
    const upright = join(this.directory, 'upright.png');
    const complete = join(this.directory, 'complete.png');
    try {
      if (result.image.path !== this.workerRequest.outputPath || result.model !== this.request.model) {
        throw new Error('Worker returned an unexpected artifact.');
      }
      // Reject symlinks and decode an independent copy of the worker's finished file.
      await snapshotImage(this.workerRequest.outputPath, snapshot, signal, true);
      const image = await normalizeImage(snapshot, upright, false, signal, true);
      if (image.width !== result.image.size.width || image.height !== result.image.size.height ||
          (this.workerRequest.size && (image.width !== this.workerRequest.size.width || image.height !== this.workerRequest.size.height))) {
        throw new Error('Output dimensions do not match the result or requested size.');
      }
    } catch (cause) {
      checkCancellation(signal);
      throw new PicPatchSdkError('INVALID_OUTPUT', 'Worker output is missing, malformed, or inconsistent with its metadata.', { cause });
    }
    checkCancellation(signal);
    try { await finishImage(upright, complete, this.directory, this.source === undefined ? undefined : await sourceMetadata(this.source)); }
    catch (cause) {
      checkCancellation(signal);
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('IMAGE_IO', 'Could not write the finished image.', { cause });
    }
    checkCancellation(signal);
    const { sidecar: _runtimeSidecar, outpaint: _runtimeCanvas, maskMode: _runtimeMaskMode, ...response } = result;
    const saved: EditResult = { ...response, image: { ...result.image, path: this.request.outputPath }, references: structuredClone('instruction' in this.request ? this.request.references ?? [] : []), inputGeometry: structuredClone(this.geometry) };
    if (this.maskMode) saved.maskMode = this.maskMode;
    if (this.outpaint) saved.outpaint = structuredClone(this.outpaint);
    const record = await createArtifactRecord(this.request, saved, complete, this.fingerprints);
    const published: ImageResult = { ...saved, status: 'completed', record };
    try { await publishComplete(complete, this.destination, this.directory, signal); }
    catch (cause) {
      if (cause instanceof PicPatchSdkError && cause.details.recoveryDirectory) this.retain = true;
      throw cause;
    }
    // Publication wins later cancellation. Sidecar failure cannot undo the image.
    if (this.request.sidecar === true) published.sidecar = await publishSidecar(record, sidecarPath(this.request.outputPath), sidecarPath(this.destination), this.directory);
    return published;
  }

  preserve(): void { this.retain = true; }
  async cleanup(): Promise<void> {
    if (!this.retain) await storageCleanup(() => rm(this.directory, { recursive: true, force: true }));
  }
}

export interface PlannedDestination { path: string; identity: string }
/** Read-only preflight; exclusive publication remains the authority over racing writers. */
export async function inspectDestination(request: Pick<ImageRequest, 'outputPath'>, signal?: AbortSignal): Promise<PlannedDestination> {
  checkCancellation(signal);
  let parent: string;
  try { parent = await realpath(dirname(request.outputPath)); }
  catch (cause) { throw new PicPatchSdkError('OUTPUT_IO', 'Output directory must already exist and be accessible.', { cause, subject: dirname(request.outputPath) }); }
  const destination = join(parent, basename(request.outputPath));
  for (const path of [destination]) {
    try {
      await lstat(path);
      throw new PicPatchSdkError('OUTPUT_CONFLICT', 'Output already exists; choose a new path.', { subject: path });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (cause instanceof PicPatchSdkError) throw cause;
        throw new PicPatchSdkError('OUTPUT_IO', 'Could not inspect the output destination.', { cause, subject: path });
      }
    }
  }
  try {
    const info = await stat(parent, { bigint: true });
    if (!info.isDirectory()) throw new PicPatchSdkError('INVALID_REQUEST', 'Output parent must be a directory.');
    return { path: destination, identity: `${info.dev}:${info.ino}` };
  } catch (cause) {
    if (cause instanceof PicPatchSdkError) throw cause;
    throw new PicPatchSdkError('OUTPUT_IO', 'Could not inspect the output directory.', { cause, subject: parent });
  }
}
