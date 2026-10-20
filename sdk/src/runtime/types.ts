import type { CallOptions, ModelCapabilities } from '../types.ts';

/** inspectRuntime's own arguments. The call's timeoutMs bounds startup, thirty seconds by default; shutdown has its own bounded budget. */
export interface RuntimeSettings {
  runtime?: import('./engine/types.ts').PythonRuntime;
}
export type RuntimeOperationOptions = RuntimeSettings & CallOptions;
export interface RuntimeInspection {
  pythonExecutable: string;
  status: 'worker-ready';
  workerVersion: string;
  models: ModelCapabilities[];
}
