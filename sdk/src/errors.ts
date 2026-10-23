import { isAbsolute } from 'node:path';
import workerSchema from '../protocol/worker.schema.json' with { type: 'json' };
import codes from '../protocol/error-codes.json' with { type: 'json' };
import type { ErrorCode, ErrorDetails, ErrorDiagnostic, ErrorEffect, ErrorKind, PicPatchSdkErrorData, SdkEvent, WorkerDiagnostic } from './types.ts';
export type { ErrorCode, ErrorDetails, ErrorDiagnostic, ErrorEffect, ErrorKind, PicPatchSdkErrorData } from './types.ts';

/** Shared with the worker; kind is never inferred from exception prose. */
export const errorCodes = Object.freeze(codes) as Readonly<Record<ErrorCode, ErrorKind>>;
export interface SdkErrorOptions extends ErrorOptions { effect?: ErrorEffect; subject?: string; details?: ErrorDetails }
const filesystemCodes: Record<string, ErrorCode> = { ENOENT: 'FILE_NOT_FOUND', ENOTDIR: 'FILE_NOT_FOUND', EACCES: 'PERMISSION_DENIED', EPERM: 'PERMISSION_DENIED', ENOSPC: 'DISK_FULL', EIO: 'IO_ERROR', ETIMEDOUT: 'TIMEOUT' };
/** A step's code becomes the observed cause; an interpreter or executable that is not there means the engine is missing. */
function observedCode(code: ErrorCode, cause: unknown): ErrorCode {
  const observed = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (!observed) return code;
  if (code === 'WORKER_UNAVAILABLE' && (observed === 'ENOENT' || observed === 'ENOTDIR')) return 'ENGINE_MISSING';
  return (code.endsWith('_IO') || code === 'WORKER_UNAVAILABLE') && filesystemCodes[observed] || code;
}

export class PicPatchSdkError extends Error implements PicPatchSdkErrorData {
  readonly code: ErrorCode;
  readonly kind: ErrorKind;
  effect: ErrorEffect;
  readonly subject?: string;
  readonly details: ErrorDetails;
  constructor(code: ErrorCode, message: string, options: SdkErrorOptions = {}) {
    super(message, options);
    this.name = 'PicPatchSdkError';
    this.code = observedCode(code, options.cause);
    this.kind = errorCodes[this.code];
    this.effect = options.effect ?? 'none';
    const path = (options.cause as NodeJS.ErrnoException | undefined)?.path;
    const subject = options.subject ?? (typeof path === 'string' && isAbsolute(path) ? path : undefined);
    if (subject !== undefined) this.subject = subject;
    this.details = { ...options.details };
  }
  toJSON(): PicPatchSdkErrorData {
    return { code: this.code, kind: this.kind, effect: this.effect, message: this.message,
      ...(this.subject !== undefined ? { subject: this.subject } : {}), details: structuredClone(this.details),
      ...(this.cause === undefined ? {} : { cause: safeCause(this.cause) }) };
  }
}
/** Accept errors from another realm/process, without relying on class identity. */
export function isPicPatchSdkError(value: unknown): value is PicPatchSdkErrorData {
  if (!value || typeof value !== 'object') return false;
  const item = value as PicPatchSdkErrorData;
  return typeof item.code === 'string' && Object.hasOwn(errorCodes, item.code) && item.kind === errorCodes[item.code] &&
    (item.effect === 'none' || item.effect === 'unknown') && typeof item.message === 'string' &&
    (item.subject === undefined || typeof item.subject === 'string') && !!item.details && typeof item.details === 'object' && !Array.isArray(item.details) &&
    Object.keys(item.details).every(key => ['diagnostic', 'recoveryDirectory'].includes(key)) &&
    (item.details.recoveryDirectory === undefined || typeof item.details.recoveryDirectory === 'string') &&
    (item.details.diagnostic === undefined || validDiagnostic(item.details.diagnostic));
}
/** Unknown external failures keep their original local cause; transport carries no raw cause text. */
export function sdkError(cause: unknown): PicPatchSdkError {
  if (cause instanceof PicPatchSdkError) return cause;
  if (isPicPatchSdkError(cause)) return new PicPatchSdkError(cause.code, cause.message, { ...cause, cause: cause.cause });
  return new PicPatchSdkError('INTERNAL', 'An unclassified SDK failure occurred.', { cause });
}
/**
 * The diagnostic representation a failure event carries. Transport through toJSON stays free of
 * cause text; this is for the caller's own records. The SDK accepts no credentials (download URLs
 * carrying them are refused), so there is nothing to mask.
 */
export function failureDiagnostic(error: PicPatchSdkError): NonNullable<SdkEvent['error']> {
  const { cause: _transportCause, ...data } = error.toJSON();
  return { ...data, name: error.name, ...(error.stack === undefined ? {} : { stack: error.stack }), ...(error.cause === undefined ? {} : { cause: causeDiagnostic(error.cause) }) };
}
function causeDiagnostic(value: unknown, seen = new Set<object>()): ErrorDiagnostic {
  if (typeof value !== 'object' || value === null) return { name: 'Error', message: String(value) };
  if (seen.has(value)) return { name: 'Error', message: '[circular cause]' };
  seen.add(value);
  const item = value as Record<string, unknown>;
  const data: ErrorDiagnostic = { name: typeof item.name === 'string' ? item.name : 'Error', message: typeof item.message === 'string' ? item.message : String(value) };
  for (const key of ['stack', 'code', 'syscall', 'path'] as const) if (typeof item[key] === 'string') data[key] = item[key];
  if (typeof item.errno === 'string' || typeof item.errno === 'number') data.errno = item.errno;
  if (item.cause !== undefined) data.cause = causeDiagnostic(item.cause, seen);
  return data;
}
function safeCause(cause: unknown, seen = new Set<unknown>()): unknown {
  if (!cause || typeof cause !== 'object' || seen.has(cause) || seen.size >= 4) return { kind: 'Unknown' };
  seen.add(cause);
  const error = cause as Error & { code?: unknown };
  const code = typeof error.code === 'string' && (Object.hasOwn(errorCodes, error.code) || Object.hasOwn(filesystemCodes, error.code)) ? error.code : undefined;
  return { kind: error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error',
    ...(code ? { code } : {}), ...(error.cause === undefined ? {} : { cause: safeCause(error.cause, seen) }) };
}

function validDiagnostic(value: unknown): value is WorkerDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as WorkerDiagnostic;
  const schema = workerSchema.definitions.Diagnostic.properties;
  const text = (value: unknown, limit: number) => value === undefined || typeof value === 'string' && value.length <= limit;
  return Object.keys(item).every(key => ['phase', 'causes', 'reason', 'traceback', 'exitCode', 'signal', 'output'].includes(key)) &&
    schema.phase.enum.includes(item.phase) && Array.isArray(item.causes) && item.causes.length >= 1 && item.causes.length <= 4 &&
    item.causes.every(cause => !!cause && typeof cause === 'object' && Object.keys(cause).every(key => ['kind', 'errno', 'type', 'message'].includes(key)) &&
      schema.causes.items.properties.kind.enum.includes(cause.kind) && (cause.errno === undefined || Number.isInteger(cause.errno) && cause.errno >= 0 && cause.errno <= 4095) &&
      text(cause.type, 200) && text(cause.message, 2000)) &&
    (item.reason === undefined || schema.reason.enum.includes(item.reason)) && text(item.traceback, 16_000) && text(item.output, 8192) &&
    (item.exitCode === undefined || Number.isInteger(item.exitCode)) && (item.signal === undefined || typeof item.signal === 'string');
}
