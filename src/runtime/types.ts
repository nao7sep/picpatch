import type { ModelCapabilities } from '../types.ts';
export interface RuntimeProgressEvent {
  type: 'progress';
  verb: 'inspectRuntime' | 'setupRuntime';
  stage: 'installing' | 'checking';
  message: string;
}
export interface RuntimeOperationOptions {
  signal?: AbortSignal;
  onProgress?: (event: RuntimeProgressEvent) => void;
  /** Installer phase defaults to five minutes; inspection startup defaults to thirty seconds. Shutdown has its own bounded budget. */
  timeoutMs?: number;
}
export interface RuntimeInspection {
  pythonExecutable: string;
  status: 'worker-ready';
  workerVersion: string;
  models: ModelCapabilities[];
}
export interface RuntimeSetupRequest {
  /** Unused absolute directory; its parent must exist. Never replaces an environment. */
  directory: string;
  pythonExecutable: string;
  uvExecutable: string;
  /** Refuse all network access, including Python package acquisition. */
  offline?: boolean;
  /** Optional existing uv cache, useful for offline setup. Otherwise owned by this environment. */
  cacheDirectory?: string;
}
export interface RuntimeSetupResult extends RuntimeInspection {
  directory: string;
  dependencyLockSha256: string;
}
