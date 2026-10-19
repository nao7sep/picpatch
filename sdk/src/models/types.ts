import type { ProgressEvent } from '../types.ts';
import type { EventOptions } from '../diagnostics.ts';
/** Local presence is not integrity verification or runtime compatibility. */
export interface LocalModelFile {
  path: string;
  resolvedPath: string;
  kind: 'weights' | 'configuration' | 'partial';
  bytes: number;
}
export interface ModelInspection {
  path: string;
  resolvedPath: string;
  status: 'unverified' | 'incomplete' | 'unrecognized';
  files: LocalModelFile[];
  issues: ModelIssue[];
  integrity: 'not-verified';
  compatibility: 'unknown';
}
export interface ModelIssue {
  path: string;
  code: 'MISSING_FILE' | 'EMPTY_FILE' | 'PARTIAL_FILE' | 'SKIPPED_DIRECTORY_LINK';
  message: string;
  effect: 'none';
}

export interface ModelOperationOptions extends EventOptions {
  /** Whole operation budget: one minute for inspection/discovery, ten for verification. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}
export interface ModelDiscovery {
  models: ModelInspection[];
  failures?: ModelDiscoveryFailure[];
}
export interface ModelDiscoveryFailure { path: string; error: import('../errors.ts').PicPatchSdkErrorData }

export type { ModelManifest, ModelComponent } from '../contracts.generated.ts';
export interface ModelVerification {
  path: string;
  manifest: import('../contracts.generated.ts').ModelManifest;
  status: 'matches-manifest' | 'invalid';
  compatibility: 'unknown';
  components: VerifiedComponent[];
}
export interface VerifiedComponent {
  code: 'MODEL_COMPONENT_VERIFIED' | 'MODEL_COMPONENT_MISSING' | 'MODEL_COMPONENT_NOT_FILE' | 'MODEL_COMPONENT_PATH_ESCAPE' | 'MODEL_COMPONENT_SIZE_MISMATCH' | 'MODEL_COMPONENT_DIGEST_MISMATCH' | 'MODEL_COMPONENT_CHANGED' | 'MODEL_COMPONENT_INVALID_INDEX';
  message: string;
  effect: 'none';
  path: string;
  status: 'verified' | 'missing' | 'not-file' | 'path-escape' | 'size-mismatch' | 'digest-mismatch' | 'changed' | 'invalid-index';
  sha256?: string;
}

export type ModelVerificationOptions = ModelOperationOptions;
