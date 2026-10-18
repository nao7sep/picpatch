import { storageScope, storageSignal, storageWait } from '../storage.ts';
import packageInfo from '../../package.json' with { type: 'json' };
import { contractValidator } from '../contracts.ts';
import { PicPatchSdkError } from '../errors.ts';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, open } from '../storage.ts';
import { basename, join } from 'node:path';
import type { ArtifactRecord, EditResult, SidecarOutcome } from '../contracts.generated.ts';
import type { ImageRequest } from '../types.ts';

/** Reproducibility metadata never enters the image. Hashes identify encoded file bytes. */
export async function createArtifactRecord(request: ImageRequest, result: EditResult, complete: string, fingerprints: ArtifactRecord['fingerprints'], caller?: ArtifactRecord['caller']): Promise<ArtifactRecord> {
    const hash = createHash('sha256');
    let bytes = 0;
    await storageWait(async () => { for await (const chunk of createReadStream(complete, { signal: storageSignal() })) { hash.update(chunk); bytes += chunk.length; } }, complete);
    const inputsIncluded = request.sidecar?.includeInputs === true;
    const { negativePrompt, ...parameters } = result.effectiveParameters;
    const record: ArtifactRecord = {
      version: 1, writer: { name: 'picpatchsdk', version: packageInfo.version }, fingerprints, ...(caller ? { caller } : {}), operation: 'prompt' in request ? 'generate' : 'edit', inputsIncluded,
      image: { filename: basename(result.image.path), mimeType: result.image.mimeType, size: result.image.size }, sha256: hash.digest('hex'), bytes,
      ...(result.control ? { control: result.control } : {}),
      ...(result.loras ? { loras: result.loras } : {}),
      ...(result.conditioning ? { conditioning: result.conditioning } : {}),
      ...(result.outpaint ? { outpaint: result.outpaint } : {}),
      model: result.model, modelRevision: result.modelRevision, runtime: result.runtime, seed: result.seed,
      effectiveParameters: inputsIncluded ? result.effectiveParameters : parameters,
      ...(inputsIncluded ? { inputs: 'prompt' in request ? { prompt: request.prompt, ...(request.control ? { controlImage: basename(request.control.image), geometry: (result.inputGeometry ?? []).map(({ path, ...geometry }) => ({ ...geometry, filename: basename(path) })) } : {}) } : {
        instruction: request.instruction,
        ...(request.control ? { controlImage: basename(request.control.image) } : {}),
        ...(request.sourceImage ? { sourceImage: basename(request.sourceImage) } : {}),
        ...(request.maskImage ? { maskImage: basename(request.maskImage) } : {}),
        references: result.references.map(group => ({ id: group.id, role: group.role, ...(group.conditioning ? { conditioning: group.conditioning } : {}), ...(group.className ? { className: group.className } : {}), images: [basename(group.images[0]), ...group.images.slice(1).map(path => basename(path))] })),
        geometry: (result.inputGeometry ?? []).map(({ path, ...geometry }) => ({ ...geometry, filename: basename(path) })),
      } } : {}),
    };
    if (!contractValidator('ArtifactRecord')(record)) throw new PicPatchSdkError('INVALID_OUTPUT', 'Invalid artifact provenance.');
    return record;
}

export function sidecarPath(image: string): string {
  return image.slice(0, -4) + '-picpatchsdk.json';
}

/** Called only after PNG publication; settlement must never disguise a saved image. */
export async function publishSidecar(record: ArtifactRecord, path: string, destination: string, directory: string): Promise<SidecarOutcome> {
  return storageScope(AbortSignal.timeout(30_000), async () => {
  let publishing = false;
  try {
    const staging = join(directory, 'sidecar.json');
    const file = await open(staging, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    // Each file publishes exclusively. The pair is deliberately not called atomic.
    publishing = true;
    await link(staging, destination);
    return { status: 'saved', path };
  } catch (cause) {
    // OUTPUT_IO classification can only select these filesystem causes.
    const code = (cause instanceof PicPatchSdkError && cause.kind === 'cancelled' ? 'TIMEOUT' : (cause as NodeJS.ErrnoException).code === 'EEXIST' ? 'OUTPUT_CONFLICT' : new PicPatchSdkError('OUTPUT_IO', 'Sidecar write failed.', { cause }).code) as Extract<SidecarOutcome, { status: 'failed' }>['code'];
    return { status: 'failed', path, code, effect: publishing && code !== 'OUTPUT_CONFLICT' ? 'unknown' : 'none', message: 'Image was saved, but its metadata sidecar could not be saved.' };
  }
  });
}
