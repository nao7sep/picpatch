import type { EventOptions } from '../diagnostics.ts';
import type { ModelCapabilities } from '../types.ts';
export interface RuntimeProgressEvent {
  type: 'progress';
  verb: 'inspectRuntime';
  stage: 'checking';
  message: string;
}
export interface RuntimeOperationOptions extends EventOptions {
  signal?: AbortSignal;
  onProgress?: (event: RuntimeProgressEvent) => void;
  /** Inspection startup defaults to thirty seconds. Shutdown has its own bounded budget. */
  timeoutMs?: number;
}
export interface RuntimeInspection {
  pythonExecutable: string;
  status: 'worker-ready';
  workerVersion: string;
  models: ModelCapabilities[];
}
