import { constants } from 'node:fs';
import { open } from '../storage.ts';
import { contractValidator } from '../contracts.ts';
import type { ArtifactRecord } from '../contracts.generated.ts';
import { withDiagnostics } from '../diagnostics.ts';
import { PicPatchSdkError } from '../errors.ts';
import { absolutePath, checkSignal, validateOperation } from '../operations.ts';
import type { CallOptions, Refusal } from '../types.ts';
import { inspectImage } from './fingerprint.ts';
import { newerVersion, versionRefusal } from '../versions.ts';

export type ArtifactReadOptions = CallOptions;
export type ArtifactRefusal = Refusal<'ARTIFACT_VERSION_UNSUPPORTED' | 'ARTIFACT_MISMATCH'>;
export type ArtifactRecordResult = { status: 'completed'; record: ArtifactRecord } | Refusal<'ARTIFACT_VERSION_UNSUPPORTED'>;
export interface ArtifactVerification { status: 'completed'; imagePath: string; record: ArtifactRecord }

/** Throws for an invalid record; a newer version is the caller's to refuse. */
export function checkArtifactRecord(value: unknown): ArtifactRecord {
  if (!contractValidator<ArtifactRecord>('ArtifactRecord')(value)) throw new PicPatchSdkError('INVALID_REQUEST', 'Invalid artifact record.');
  if (!value.inputsIncluded && (value.inputs !== undefined || value.effectiveParameters.negativePrompt !== undefined)) throw new PicPatchSdkError('INVALID_REQUEST', 'Private input fields require explicit retention.');
  return structuredClone(value);
}
/** Validates a record the caller holds; a newer format version is refused, as the reader refuses it. */
export function validateArtifactRecord(value: unknown): ArtifactRecordResult {
  const version = newerVersion(value);
  if (version !== undefined) return versionRefusal('ARTIFACT_VERSION_UNSUPPORTED', 'This artifact record version is unsupported.', version);
  return { status: 'completed', record: checkArtifactRecord(value) };
}
export function readArtifactRecord(path: string, options: ArtifactReadOptions = {}): Promise<ArtifactRecordResult> {
  return withDiagnostics('readArtifactRecord', options, async operation => {
    absolutePath(path); validateOperation(operation);
    const signal = operation.signal;
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
      const result = validateArtifactRecord(value);
      return result.status === 'refused' ? { ...result, subject: path } : result;
    } catch (cause) {
      checkSignal(signal);
      if (cause instanceof PicPatchSdkError) throw cause;
      throw new PicPatchSdkError('RECORD_IO', 'Could not read the artifact record.', { cause, subject: path });
    } finally { await file?.close(); }
  });
}
/** Confirms correspondence with file bytes and decoded dimensions, never creator authenticity. */
export function verifyArtifact(imagePath: string, input: ArtifactRecord, options: ArtifactReadOptions = {}): Promise<ArtifactVerification | ArtifactRefusal> {
  return withDiagnostics('verifyArtifact', options, async operation => {
    absolutePath(imagePath); validateOperation(operation);
    const valid = validateArtifactRecord(input);
    if (valid.status === 'refused') return valid;
    const { record } = valid;
    const signal = operation.signal;
    checkSignal(signal);
    try {
      const { fingerprint, metadata } = await inspectImage(imagePath, signal, true);
      // The record's size is the image as displayed; an edit keeps its source's stored orientation.
      const size = metadata.autoOrient ?? metadata;
      if (metadata.format === 'png' && (metadata.pages ?? 1) === 1 && size.width === record.image.size.width && size.height === record.image.size.height && fingerprint.bytes === record.bytes && fingerprint.sha256 === record.sha256) return { status: 'completed', imagePath, record };
    } catch (cause) {
      if (!(cause instanceof PicPatchSdkError) || !['INVALID_IMAGE', 'INPUTS_CHANGED'].includes(cause.code)) throw cause;
    }
    return { status: 'refused', code: 'ARTIFACT_MISMATCH', message: 'The image does not match this record.', subject: imagePath, details: {} };
  });
}
