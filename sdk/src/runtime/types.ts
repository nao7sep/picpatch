import type { CallOptions, ModelCapabilities } from '../types.ts';

/** timeoutMs bounds startup, thirty seconds by default; shutdown has its own bounded budget. */
export interface RuntimeOperationOptions extends CallOptions {
  runtime?: import('./engine/types.ts').PythonRuntime;
}
export interface RuntimeInspection {
  pythonExecutable: string;
  status: 'worker-ready';
  workerVersion: string;
  models: ModelCapabilities[];
}
