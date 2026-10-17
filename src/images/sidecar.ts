import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRecord, EditResult, SidecarOutcome } from '../contracts.generated.ts';
import type { ImageRequest } from '../types.ts';

/** Called only after PNG publication; settlement must never disguise a saved image. */
export async function publishSidecar(request: ImageRequest, result: EditResult, complete: string, destination: string, directory: string): Promise<SidecarOutcome> {
  const path = `${request.outputPath}.json`;
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(complete)) { hash.update(chunk); bytes += chunk.length; }
    const inputsIncluded = request.sidecar?.includeInputs === true;
    const { negativePrompt, ...parameters } = result.effectiveParameters;
    const record: ArtifactRecord = {
      version: 1, operation: 'prompt' in request ? 'generate' : 'edit', inputsIncluded,
      image: result.image, sha256: hash.digest('hex'), bytes,
      model: result.model, modelRevision: result.modelRevision, runtime: result.runtime, seed: result.seed,
      effectiveParameters: inputsIncluded ? result.effectiveParameters : parameters,
      ...(inputsIncluded ? { inputs: 'prompt' in request ? { prompt: request.prompt } : {
        instruction: request.instruction,
        ...(request.sourceImage ? { sourceImage: request.sourceImage } : {}),
        ...(request.maskImage ? { maskImage: request.maskImage } : {}),
        references: result.references, geometry: result.inputGeometry ?? [],
      } } : {}),
    };
    const staging = join(directory, 'sidecar.json');
    const file = await open(staging, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    // Each file publishes exclusively. The pair is deliberately not called atomic.
    await link(staging, destination);
    return { status: 'saved', path };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code === 'EEXIST' ? 'OUTPUT_CONFLICT' : 'OUTPUT_IO';
    return { status: 'failed', path, code, message: 'Image was saved, but its metadata sidecar could not be saved.' };
  }
}
