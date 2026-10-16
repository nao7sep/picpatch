import type { WorkerDiagnostic } from './diagnostics.ts';
export class PicPatchUsageError extends Error {
  readonly category = 'usage';
  recoveryDirectory?: string;
  readonly code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'OUTPUT_CONFLICT' | 'BUSY' | 'DISPOSED' | 'INVALID_IMAGE' | 'INVALID_MASK';
  constructor(code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'OUTPUT_CONFLICT' | 'BUSY' | 'DISPOSED' | 'INVALID_IMAGE' | 'INVALID_MASK', message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'PicPatchUsageError';
  }
}

export class PicPatchRuntimeError extends Error {
  diagnostic?: WorkerDiagnostic;
  readonly category = 'runtime';
  recoveryDirectory?: string;
  readonly code: 'INVALID_CAPABILITIES' | 'PROTOCOL_ERROR' | 'WORKER_UNAVAILABLE' | 'WORKER_EXITED' | 'TIMEOUT' | 'TERMINATION_FAILED' | 'CALLBACK_FAILED' | 'BACKEND_UNAVAILABLE' | 'RUNTIME_FAILURE' | 'IMAGE_IO' | 'INVALID_OUTPUT' | 'OUTPUT_IO' | 'CLEANUP_FAILED' | 'MODEL_IO';
  constructor(code: 'INVALID_CAPABILITIES' | 'PROTOCOL_ERROR' | 'WORKER_UNAVAILABLE' | 'WORKER_EXITED' | 'TIMEOUT' | 'TERMINATION_FAILED' | 'CALLBACK_FAILED' | 'BACKEND_UNAVAILABLE' | 'RUNTIME_FAILURE' | 'IMAGE_IO' | 'INVALID_OUTPUT' | 'OUTPUT_IO' | 'CLEANUP_FAILED' | 'MODEL_IO', message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'PicPatchRuntimeError';
  }
}

export class PicPatchCancelledError extends Error {
  readonly category = 'cancelled';
  readonly code = 'CANCELLED';
  constructor(message = 'The edit was cancelled.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PicPatchCancelledError';
  }
}
