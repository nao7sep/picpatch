import type { EventOptions } from './diagnostics.ts';
export interface ProgressEvent { type: 'progress'; stage: string; completed: number; total: number }
export type { GenerateRequest, EditRequest, InputGeometry, ImageArtifact, ImageSize, ModelCapabilities, ReferenceGroup } from './contracts.generated.ts';

export interface OperationOptions extends EventOptions {
  readonly signal?: AbortSignal;
  /** Optional calling app identity, separate from the SDK record writer. */
  readonly caller?: import('./contracts.generated.ts').ArtifactRecord['caller'];
  /** Total budget from submission, including time waiting on this image client. */
  readonly timeoutMs?: number;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** Generation returns the same artifact/provenance, with empty references and inputGeometry. */
export type GenerateResult = ImageResult;
export type EditResult = ImageResult;
export type ImageRequest = import('./contracts.generated.ts').EditRequest | import('./contracts.generated.ts').GenerateRequest;

export interface OperationRefusal {
  status: 'refused';
  code: 'OUTPUT_CONFLICT' | 'INPUTS_CHANGED' | 'DESTINATION_CHANGED';
  message: string;
  effect: import('./errors.ts').ErrorEffect;
  subject: string;
  details: import('./errors.ts').ErrorDetails;
}
export type ImageResult = import('./contracts.generated.ts').EditResult & { record: import('./contracts.generated.ts').ArtifactRecord };
export type ImageOutcome = ImageResult | OperationRefusal;
