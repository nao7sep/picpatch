import type { ProgressEvent } from './contracts.generated.ts';
export type { EditRequest, EditResult, ImageArtifact, ImageSize, ModelCapabilities, ProgressEvent, ReferenceGroup } from './contracts.generated.ts';

export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}
