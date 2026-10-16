export class PicPatchUsageError extends Error {
  readonly category = 'usage';
  readonly code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'OUTPUT_CONFLICT';
  constructor(code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'OUTPUT_CONFLICT', message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'PicPatchUsageError';
  }
}

export class PicPatchRuntimeError extends Error {
  readonly category = 'runtime';
  readonly code: 'INVALID_CAPABILITIES' | 'PROTOCOL_ERROR' | 'WORKER_UNAVAILABLE';
  constructor(code: 'INVALID_CAPABILITIES' | 'PROTOCOL_ERROR' | 'WORKER_UNAVAILABLE', message: string, options?: ErrorOptions) {
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
