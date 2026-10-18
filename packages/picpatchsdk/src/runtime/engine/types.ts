import type { EventOptions } from '../../diagnostics.ts';

/** Engine storage is local-disk storage. No shared-network filesystem semantics are promised. */
export interface EngineOptions extends EventOptions {
  engineDirectory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface InstallEngineOptions extends EngineOptions {
  /** Absolute path to caller-provided uv. PicPatchSdk never installs uv or build tools. */
  uvExecutable: string;
  cacheDirectory?: string;
  pythonDirectory?: string;
  /** Absolute directories containing prerequisite build tools, ahead of the OS tool path. */
  toolDirectories?: string[];
  /** Reuse cached packages/interpreters without network access. Defaults to false. */
  offline?: boolean;
}
export interface EngineIdentity {
  id: string;
  platform: 'darwin';
  architecture: 'arm64';
  python: '3.15.0';
  dependencies: 'inference';
  lockSha256: string;
  manifestSha256: string;
}
/** Versioned readiness reference. The installation is a single basename, never a caller path. */
export interface EngineRecord {
  version: 1;
  identity: EngineIdentity;
  installation: string;
}
export interface ReadyEngine {
  status: 'ready';
  code: 'ENGINE_READY';
  identity: EngineIdentity;
  engineDirectory: string;
  pythonExecutable: string;
}
export type EngineInspection = ReadyEngine | {
  status: 'missing' | 'incompatible';
  code: 'ENGINE_MISSING' | 'ENGINE_RECORD_INVALID' | 'ENGINE_CHECK_FAILED';
  identity: EngineIdentity;
  engineDirectory: string;
};
export interface EngineInstallation extends ReadyEngine { origin: 'installed' | 'reused' }
