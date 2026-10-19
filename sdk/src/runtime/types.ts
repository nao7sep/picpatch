import type { ProgressEvent } from '../types.ts';
import type { EventOptions } from '../diagnostics.ts';
import type { ModelCapabilities } from '../types.ts';

export interface RuntimeOperationOptions extends EventOptions {
  runtime?: import('./engine/types.ts').EngineRuntime;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  /** Inspection startup defaults to thirty seconds. Shutdown has its own bounded budget. */
  timeoutMs?: number;
}
export interface RuntimeInspection {
  pythonExecutable: string;
  status: 'worker-ready';
  workerVersion: string;
  models: ModelCapabilities[];
}
