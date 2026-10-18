import { constants } from 'node:fs';
import { open } from '../storage.ts';
import { contractValidator } from '../contracts.ts';
import type { ArtifactRecord } from '../contracts.generated.ts';
import { withDiagnostics, type EventOptions } from '../diagnostics.ts';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, timeBudget, validateOperation, withDeadline } from '../operations.ts';
import { inspectImage } from './fingerprint.ts';

export interface ArtifactReadOptions extends EventOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ArtifactRefusal {
  status: 'refused';
  code: 'ARTIFACT_VERSION_UNSUPPORTED' | 'ARTIFACT_MISMATCH';
  message: string;
  effect: 'none';
  subject: string;
}
export interface ArtifactVerification { status: 'verified'; imagePath: string; record: ArtifactRecord }
export function validateArtifactRecord(value: unknown): ArtifactRecord {
  if (!contractValidator<ArtifactRecord>('ArtifactRecord')(value)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid artifact record.');
  if (!value.inputsIncluded && (value.inputs !== undefined || value.effectiveParameters.negativePrompt !== undefined)) throw new PicPatchSdkError('INVALID_REQUEST', 'Private input fields require explicit retention.');
  return structuredClone(value);
}
export function readArtifactRecord(path: string, options: ArtifactReadOptions = {}): Promise<import('../logging.ts').Logged<{ status: 'read'; record: ArtifactRecord } | ArtifactRefusal>> {
  return withDiagnostics('readArtifactRecord', options, async operation => {
    absolutePath(path); validateOperation(operation);
    return withDeadline(operation.signal, timeBudget(operation.timeoutMs, 30_000), 'Artifact record read timed out.', async signal => {
      checkSignal(signal);
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        if (!(await file.stat()).isFile()) throw new PicPatchSdkError('INVALID_REQUEST', 'Artifact records must be regular files.', { subject: path });
        checkSignal(signal);
        const bytes = await file.readFile({ encoding: 'utf8', signal });
        let value: unknown;
        try { value = JSON.parse(bytes); } catch (cause) { throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid artifact record JSON.', { cause, subject: path }); }
        checkSignal(signal);
        const version = (value as { version?: unknown } | null)?.version;
        if (Number.isInteger(version) && version !== 1) return { status: 'refused', code: 'ARTIFACT_VERSION_UNSUPPORTED', message: 'This artifact record version is unsupported.', effect: 'none', subject: path };
        return { status: 'read' as const, record: validateArtifactRecord(value) };
      } catch (cause) {
        checkSignal(signal);
        if (cause instanceof PicPatchSdkError) throw cause;
        throw new PicPatchSdkError('IMAGE_IO', 'Could not read the artifact record.', { cause, subject: path });
      } finally { await file?.close(); }
    });
  });
}
/** Confirms correspondence with file bytes and decoded dimensions, never creator authenticity. */
export function verifyArtifact(imagePath: string, input: ArtifactRecord, options: ArtifactReadOptions = {}): Promise<import('../logging.ts').Logged<ArtifactVerification | ArtifactRefusal>> {
  return withDiagnostics('verifyArtifact', options, async operation => {
    absolutePath(imagePath); validateOperation(operation);
    const record = validateArtifactRecord(input);
    return withDeadline(operation.signal, timeBudget(operation.timeoutMs, 60_000), 'Artifact verification timed out.', async signal => {
      try {
        const { fingerprint, metadata } = await inspectImage(imagePath, signal, true);
        if (metadata.format === 'png' && (metadata.pages ?? 1) === 1 && metadata.width === record.image.size.width && metadata.height === record.image.size.height && fingerprint.bytes === record.bytes && fingerprint.sha256 === record.sha256) return { status: 'verified', imagePath, record };
      } catch (cause) {
        if (!(cause instanceof PicPatchSdkError) || !['INVALID_IMAGE', 'INPUTS_CHANGED'].includes(cause.code)) throw cause;
      }
      return { status: 'refused', code: 'ARTIFACT_MISMATCH', message: 'The image does not match this record.', effect: 'none', subject: imagePath };
    });
  });
}
