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
  verb: 'inspectModel' | 'discoverModels';
  stage: 'inspecting';
  message: string;
  path: string;
}
export interface ModelOperationOptions {
  signal?: AbortSignal;
  onProgress?: (event: ModelProgressEvent) => void;
}
export interface ModelDiscovery {
  models: ModelInspection[];
}
