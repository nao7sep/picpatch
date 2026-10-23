// The public types every entry shares. No Node dependencies: the browser entry re-exports them,
// so a type here may import only from other dependency-free modules.
import type { ArtifactRecord, EditResult as WorkerResult, EditRequest, GenerateRequest, ImageArtifact, ImageSize, SamplingParameters, SidecarOutcome } from './contracts.generated.ts';
import type { RuntimeName } from './hosts.ts';
export type { GenerateRequest, EditRequest, InputGeometry, ImageArtifact, ImageSize, ModelCapabilities, ReferenceGroup } from './contracts.generated.ts';

export type ErrorKind = 'invalid' | 'unavailable' | 'cancelled' | 'internal';
export type ErrorEffect = 'none' | 'unknown';
export type ErrorCode = keyof typeof import('../protocol/error-codes.json', { with: { type: 'json' } });
export interface WorkerDiagnostic {
  phase: 'loading' | 'generating' | 'editing' | 'saving' | 'worker';
  causes: { kind: 'BackendUnavailable' | 'ModuleNotFoundError' | 'FileNotFoundError' | 'PermissionError' | 'MemoryError' | 'ValueError' | 'OSError' | 'RuntimeError' | 'Exception' | 'ProcessExit'; errno?: number }[];
  reason?: 'missing-package' | 'unsupported-version' | 'missing-directory';
  exitCode?: number;
  signal?: string;
}
export interface ErrorDetails { diagnostic?: WorkerDiagnostic; recoveryDirectory?: string }
export interface PicPatchSdkErrorData {
  code: ErrorCode;
  kind: ErrorKind;
  effect: ErrorEffect;
  message: string;
  subject?: string;
  details: ErrorDetails;
  cause?: unknown;
}

export interface WorkerTimeouts {
  startupMs: number;
  editMs: number;
  generateMs?: number;
  cancellationMs: number;
  shutdownMs: number;
  terminationMs: number;
}
export interface RuntimeConfiguration { backend?: RuntimeName; timeouts?: WorkerTimeouts }
export interface SdkEvent {
  type: 'event';
  name: 'sdk.startup' | 'operation.started' | 'operation.succeeded' | 'operation.refused' | 'operation.failed' | 'operation.cancelled' | 'operation.stage' | 'hook.failed' | 'operation.progress';
  startup?: { sdk: string; version: string; runtime: { node: string; platform: string; architecture: string }; configuration: RuntimeConfiguration };
  refusal?: { code: RefusalCode };
  progress?: { completed: number; total: number };
  operationId: string;
  verb: string;
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  /** A failure's diagnostic representation: the error's fields with its message, stack and full cause chain. */
  error?: Omit<PicPatchSdkErrorData, 'cause'> & { name: string; stack?: string; cause?: ErrorDiagnostic };
}
/** One error in a failure's cause chain, as plain data. */
export interface ErrorDiagnostic { name: string; message: string; stack?: string; code?: string; errno?: number | string; syscall?: string; path?: string; cause?: ErrorDiagnostic }
export interface ProgressEvent { type: 'progress'; stage: string; completed: number; total: number }
export interface EventOptions {
  /** Include diagnostic progress counts in onEvent. Off by default; no environment is read. */
  debug?: boolean;
  onEvent?: (event: SdkEvent) => void;
}
/**
 * The call options every verb accepts. A verb with nothing to report through a hook never calls it;
 * timeoutMs is the call's whole budget. Settings a verb needs beyond these sit beside them.
 */
export interface CallOptions extends EventOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void;
}
/** Image client calls take the call options alone; the total budget includes time waiting on the client. */
export type OperationOptions = CallOptions;

/** Every refusal code a verb may return, as data. */
export const refusalCodes = [
  'OUTPUT_CONFLICT', 'INPUTS_CHANGED', 'DESTINATION_CHANGED',
  'ARTIFACT_MISMATCH', 'ARTIFACT_VERSION_UNSUPPORTED', 'PROFILE_VERSION_UNSUPPORTED',
  'MODEL_INCOMPLETE', 'MODEL_REGISTRATION_VERSION_UNSUPPORTED',
] as const;
export type RefusalCode = typeof refusalCodes[number];
export interface ModelPresenceIssue {
  path: string;
  code: 'MODEL_FILE_MISSING' | 'MODEL_FILE_NOT_REGULAR' | 'MODEL_FILE_SIZE_MISMATCH' | 'MODEL_DIRECTORY_ESCAPE';
  message: string;
  effect: 'none';
}
export interface RefusalDetails {
  /** The newer format version that was refused, unchanged on disk. */
  version?: number;
  /** Model components that are not present at their declared location and size. */
  issues?: ModelPresenceIssue[];
  /** A completed output the refused publication retained privately. */
  recoveryDirectory?: string;
}
/** The one refusal shape: the operation decided not to proceed and changed nothing it was asked to change. */
export interface Refusal<C extends RefusalCode = RefusalCode> {
  status: 'refused';
  code: C;
  message: string;
  subject?: string;
  details: RefusalDetails;
}

/** Defaults an image client applies where a request leaves a field out. */
export interface ImageDefaults { size?: ImageSize; seed?: number; outputDirectory?: string; parameters?: SamplingParameters }
export type GenerateInput = Omit<GenerateRequest, 'model' | 'outputPath'> & { model?: string; outputPath?: string; outputDirectory?: string };
export type EditInput = Omit<EditRequest, 'model' | 'outputPath'> & { model?: string; outputPath?: string; outputDirectory?: string };
/** Caller-owned argument bundle. Paths are absolute literals; never discovered or written by the SDK. */
export interface PicPatchProfile {
  version: 1;
  engineDirectory?: string;
  modelsDirectory?: string;
  nativeExecutable?: string;
  defaults?: ImageDefaults;
  timeouts?: Partial<WorkerTimeouts>;
}

/** Generation returns the same artifact/provenance, with empty references and inputGeometry. */
export type ImageResult = WorkerResult & { status: 'completed'; record: ArtifactRecord };
export type GenerateResult = ImageResult;
export type EditResult = ImageResult;
export type ImageRequest = EditRequest | GenerateRequest;
export type OperationRefusal = Refusal<'OUTPUT_CONFLICT' | 'INPUTS_CHANGED' | 'DESTINATION_CHANGED'>;
export type ImageOutcome = ImageResult | OperationRefusal;
/** saveArtifact's result: the copy, the record it holds and, when one was asked for, its sidecar's outcome. */
export interface SavedArtifact {
  status: 'completed';
  image: ImageArtifact;
  record: ArtifactRecord;
  sidecar?: SidecarOutcome;
  cleanupWarning?: { directory: string; message: string };
}
export type SaveArtifactRefusal = Refusal<'ARTIFACT_MISMATCH' | 'ARTIFACT_VERSION_UNSUPPORTED' | 'OUTPUT_CONFLICT'>;
