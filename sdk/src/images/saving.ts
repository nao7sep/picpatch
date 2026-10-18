import { basename, join } from 'node:path';
import { mkdtemp, rm, storageCleanup, storageRecovery, storageStalled } from '../storage.ts';
import { withDiagnostics, type EventOptions } from '../diagnostics.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { PicPatchSdkError } from '../errors.ts';
import type { ArtifactRecord, ImageArtifact, SidecarOutcome } from '../contracts.generated.ts';
import type { Logged } from '../logging.ts';
import { validateArtifactRecord } from './records.ts';
import { inspectImage } from './fingerprint.ts';
import { snapshotImage } from './validation.ts';
import { inspectDestination } from './output.ts';
import { publishComplete } from './publication.ts';
import { publishSidecar, sidecarPath } from './sidecar.ts';
import { dirname } from 'node:path';

export interface SaveArtifactOptions extends EventOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Write the supplied private record beside the saved image. Defaults to false. */
  sidecar?: boolean;
}
export interface SavedArtifact {
  status: 'saved';
  image: ImageArtifact;
  record: ArtifactRecord;
  sidecar?: SidecarOutcome;
  cleanupWarning?: { directory: string; message: string };
}
export interface SaveArtifactRefusal {
  status: 'refused';
  code: 'ARTIFACT_MISMATCH' | 'OUTPUT_CONFLICT';
  message: string;
  effect: import('../errors.ts').ErrorEffect;
  subject: string;
  details: import('../errors.ts').ErrorDetails;
}
/** Save an existing PNG without inference, re-encoding, overwriting or modifying its source. */
export function saveArtifact(imagePath: string, outputPath: string, input: ArtifactRecord, options: SaveArtifactOptions = {}): Promise<Logged<SavedArtifact | SaveArtifactRefusal>> {
  return withDiagnostics('saveArtifact', options, async operation => {
    validateOperation(operation, ['sidecar']); absolutePath(imagePath); absolutePath(outputPath);
    if (!outputPath.toLowerCase().endsWith('.png') || (operation.sidecar !== undefined && typeof operation.sidecar !== 'boolean')) throw new PicPatchSdkError('INVALID_REQUEST', 'Save to a PNG path with an optional boolean sidecar selection.');
    const record = validateArtifactRecord(input);
    record.image.filename = basename(outputPath);
    validateArtifactRecord(record);
    let saved: SavedArtifact | undefined;
    try {
      return await withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Artifact saving timed out.', async signal => {
        const destination = await inspectDestination({ outputPath }, signal);
        const directory = await mkdtemp(join(dirname(destination.path), '.picpatch-'));
        storageRecovery(directory);
        let retain = false;
        try {
          const complete = join(directory, 'complete.png');
          await snapshotImage(imagePath, complete, signal, false, { bytes: record.bytes, sha256: record.sha256 });
          const { metadata } = await inspectImage(complete, signal, true);
          if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || metadata.width !== record.image.size.width || metadata.height !== record.image.size.height) throw new PicPatchSdkError('INVALID_IMAGE', 'Image dimensions do not match the record.', { subject: imagePath });
          checkSignal(signal);
          await publishComplete(complete, destination.path, directory, signal);
          saved = { status: 'saved', image: { path: outputPath, mimeType: 'image/png', size: { ...record.image.size } }, record };
          if (operation.sidecar) saved.sidecar = await publishSidecar(record, sidecarPath(outputPath), sidecarPath(destination.path), directory);
          return saved;
        } catch (cause) {
          retain = cause instanceof PicPatchSdkError && cause.details.recoveryDirectory !== undefined;
          throw cause;
        } finally {
          if (storageStalled()) retain = true;
          if (!retain) {
            try { await storageCleanup(() => rm(directory, { recursive: true, force: true })); }
            catch (cause) {
              retain = true;
              if (!saved) throw new PicPatchSdkError('CLEANUP_FAILED', 'Private save files could not be removed.', { cause, effect: 'unknown', details: { recoveryDirectory: directory } });
            }
          }
          if (saved && retain) saved.cleanupWarning = { directory, message: 'Image was saved; private files were retained.' };
        }
      });
    } catch (cause) {
      if (saved) return saved; // Confirmed publication wins later cancellation.
      if (cause instanceof PicPatchSdkError && ['OUTPUT_CONFLICT', 'INPUTS_CHANGED', 'INVALID_IMAGE'].includes(cause.code)) return {
        status: 'refused', code: cause.code === 'OUTPUT_CONFLICT' ? 'OUTPUT_CONFLICT' : 'ARTIFACT_MISMATCH', message: cause.message,
        effect: cause.effect, subject: cause.subject ?? imagePath, details: cause.details,
      };
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('OUTPUT_IO', 'Could not save the image artifact.', { cause, subject: outputPath });
    }
  });
}
