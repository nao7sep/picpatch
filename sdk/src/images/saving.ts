import { basename, join } from 'node:path';
import { mkdtemp, rm, storageCleanup, storageRecovery, storageStalled } from '../storage.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { PicPatchSdkError } from '../errors.ts';
import type { ArtifactRecord } from '../contracts.generated.ts';
import { checkArtifactRecord, validateArtifactRecord } from './records.ts';
import type { CallOptions } from '../types.ts';
import { inspectImage } from './fingerprint.ts';
import { snapshotImage } from './validation.ts';
import { inspectDestination } from './output.ts';
import { publishComplete } from './publication.ts';
import { publishSidecar, sidecarPath } from './sidecar.ts';
import { dirname } from 'node:path';

export interface SaveArtifactOptions extends CallOptions {
  /** Write the record beside the saved image. Defaults to false. */
  sidecar?: boolean;
  /** Keep the prompt, negative prompt and input descriptions the record holds. Defaults to true; false leaves them out of the saved record. */
  includeInputs?: boolean;
}
export type { SavedArtifact, SaveArtifactRefusal } from '../types.ts';
import type { SavedArtifact, SaveArtifactRefusal } from '../types.ts';
/** Save an existing PNG without inference, re-encoding, overwriting or modifying its source. */
export function saveArtifact(imagePath: string, outputPath: string, input: ArtifactRecord, options: SaveArtifactOptions = {}): Promise<SavedArtifact | SaveArtifactRefusal> {
  return withDiagnostics('saveArtifact', options, async operation => {
    validateOperation(operation, ['sidecar', 'includeInputs']); absolutePath(imagePath); absolutePath(outputPath);
    if (!outputPath.toLowerCase().endsWith('.png') || [operation.sidecar, operation.includeInputs].some(value => value !== undefined && typeof value !== 'boolean')) throw new PicPatchSdkError('INVALID_REQUEST', 'Save to a PNG path with optional boolean sidecar and includeInputs selections.');
    const valid = validateArtifactRecord(input);
    if (valid.status === 'refused') return valid;
    const record = valid.record;
    record.image.filename = basename(outputPath);
    if (operation.includeInputs === false) { delete record.inputs; delete record.effectiveParameters.negativePrompt; record.inputsIncluded = false; }
    checkArtifactRecord(record);
    let saved: SavedArtifact | undefined;
    let failure: unknown;
    try {
      return await withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Artifact saving timed out.', async signal => {
        const destination = await inspectDestination({ outputPath }, signal);
        const directory = await mkdtemp(join(dirname(destination.path), '.picpatch-'));
        storageRecovery(directory);
        let retain = false;
        try {
          const complete = join(directory, 'complete.png');
          await snapshotImage(imagePath, complete, signal, false, { bytes: record.bytes, sha256: record.sha256 }, undefined, 0o666);
          const { metadata } = await inspectImage(complete, signal, true);
          // The record's size is the image as displayed; an edit keeps its source's stored orientation.
          const size = metadata.autoOrient ?? metadata;
          if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || size.width !== record.image.size.width || size.height !== record.image.size.height) throw new PicPatchSdkError('INVALID_IMAGE', 'Image dimensions do not match the record.', { subject: imagePath });
          checkSignal(signal);
          await publishComplete(complete, destination.path, directory, signal);
          saved = { status: 'completed', image: { path: outputPath, mimeType: 'image/png', size: { ...record.image.size } }, record };
          if (operation.sidecar === true) saved.sidecar = await publishSidecar(record, sidecarPath(outputPath), sidecarPath(destination.path), directory);
          return saved;
        } catch (cause) {
          retain = cause instanceof PicPatchSdkError && cause.details.recoveryDirectory !== undefined;
          failure = cause;
          throw cause;
        } finally {
          if (storageStalled()) retain = true;
          if (!retain) {
            try { await storageCleanup(() => rm(directory, { recursive: true, force: true })); }
            catch {
              retain = true;
              // The primary failure keeps its code; private files that remain are named in details.
              if (!saved && failure instanceof PicPatchSdkError) failure.details.recoveryDirectory = directory;
            }
          }
          if (saved && retain) saved.cleanupWarning = { directory, message: 'Image was saved; private files were retained.' };
        }
      });
    } catch (cause) {
      if (saved) return saved; // Confirmed publication wins later cancellation.
      if (cause instanceof PicPatchSdkError && ['OUTPUT_CONFLICT', 'INPUTS_CHANGED', 'INVALID_IMAGE'].includes(cause.code)) return {
        status: 'refused', code: cause.code === 'OUTPUT_CONFLICT' ? 'OUTPUT_CONFLICT' : 'ARTIFACT_MISMATCH', message: cause.message,
        subject: cause.subject ?? imagePath, details: cause.details.recoveryDirectory === undefined ? {} : { recoveryDirectory: cause.details.recoveryDirectory },
      };
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('OUTPUT_IO', 'Could not save the image artifact.', { cause, subject: outputPath });
    }
  });
}
