export class PicPatchUsageError extends Error {
  readonly category = 'usage';
  readonly code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'OUTPUT_CONFLICT' | 'BUSY' | 'DISPOSED';
  constructor(code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'OUTPUT_CONFLICT' | 'BUSY' | 'DISPOSED', message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'PicPatchUsageError';
  }
}

export class PicPatchRuntimeError extends Error {
  readonly category = 'runtime';
  readonly code: 'INVALID_CAPABILITIES' | 'PROTOCOL_ERROR' | 'WORKER_UNAVAILABLE' | 'WORKER_EXITED' | 'TIMEOUT' | 'TERMINATION_FAILED' | 'CALLBACK_FAILED' | 'BACKEND_UNAVAILABLE' | 'RUNTIME_FAILURE';
  constructor(code: 'INVALID_CAPABILITIES' | 'PROTOCOL_ERROR' | 'WORKER_UNAVAILABLE' | 'WORKER_EXITED' | 'TIMEOUT' | 'TERMINATION_FAILED' | 'CALLBACK_FAILED' | 'BACKEND_UNAVAILABLE' | 'RUNTIME_FAILURE', message: string, options?: ErrorOptions) {
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
