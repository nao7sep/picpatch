import type { CallOptions, PicPatchProfile } from '../../types.ts';
import type { RuntimeName } from '../../hosts.ts';

/** The runtimes the managed Python engine installs; stable-diffusion.cpp has its own native engine verbs. */
export type PythonRuntime = Exclude<RuntimeName, 'stable-diffusion.cpp'>;
/** Engine storage is local-disk storage. No shared-network filesystem semantics are promised. */
export interface EngineOptions extends CallOptions {
  /** Dependency set to prepare: a catalog entry's runtime.name where its runtime.engine is python. Defaults to mflux. */
  runtime?: PythonRuntime;
  profile?: PicPatchProfile;
  engineDirectory?: string;
}
export interface NativeEngineOptions extends CallOptions {
  profile?: PicPatchProfile;
  engineDirectory?: string;
}
export interface NativeInspectionOptions extends NativeEngineOptions {
  /** A configured sd-cli to check in place of the managed installation; defaults to the profile's nativeExecutable. */
  nativeExecutable?: string;
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
  dependencies: 'inference' | 'dreamo-inference' | 'diffusers-inference';
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
} | {
  /** This runtime has no build for this computer; nothing can be installed here. */
  status: 'unsupported';
  code: 'UNSUPPORTED_CAPABILITY';
  engineDirectory: string;
};
export interface EngineInstallation extends ReadyEngine { origin: 'installed' | 'reused' }

export interface ReadyNativeEngine { status: 'ready'; code: 'ENGINE_READY'; message: string; engineDirectory: string; nativeExecutable: string; revision: string }
export type NativeEngineInspection = ReadyNativeEngine
  | { status: 'missing' | 'incompatible'; code: 'ENGINE_MISSING' | 'ENGINE_CHECK_FAILED'; message: string; engineDirectory: string; revision: string }
  /** No pinned build exists for this computer; nothing can be installed here. */
  | { status: 'unsupported'; code: 'UNSUPPORTED_CAPABILITY'; message: string; engineDirectory: string; revision: string };
export interface NativeEngineInstallation extends ReadyNativeEngine { origin: 'installed' | 'reused'; cleanupWarning?: { directory: string; message: string } }
