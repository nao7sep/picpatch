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
}
export interface ModelProgressEvent {
  type: 'progress';
  verb: 'inspectModel' | 'discoverModels' | 'verifyModel' | 'prepareModel';
  stage: 'inspecting' | 'verifying' | 'downloading';
  message: string;
  path: string;
}
export interface ModelOperationOptions {
  /** Whole operation budget: one minute for inspection/discovery, ten for verification. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: ModelProgressEvent) => void;
}
export interface ModelDiscovery {
  models: ModelInspection[];
}

export type { ModelManifest, ModelComponent } from '../contracts.generated.ts';
export interface ModelVerification {
  path: string;
  manifest: import('../contracts.generated.ts').ModelManifest;
  status: 'matches-manifest' | 'invalid';
  compatibility: 'unknown';
  components: VerifiedComponent[];
}
export interface VerifiedComponent {
  path: string;
  status: 'verified' | 'missing' | 'not-file' | 'path-escape' | 'size-mismatch' | 'digest-mismatch' | 'changed' | 'invalid-index';
  sha256?: string;
}

export type ModelVerificationOptions = ModelOperationOptions;
