import type { EventOptions } from './diagnostics.ts';
import type { ProgressEvent } from './contracts.generated.ts';
export type { GenerateRequest, EditRequest, EditResult, InputGeometry, ImageArtifact, ImageSize, ModelCapabilities, ProgressEvent, ReferenceGroup } from './contracts.generated.ts';

export interface OperationOptions extends EventOptions {
  readonly signal?: AbortSignal;
  /** Total budget from submission, including time waiting on this editor. */
  readonly timeoutMs?: number;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** Generation returns the same artifact/provenance, with empty references and inputGeometry. */
export type GenerateResult = import('./contracts.generated.ts').EditResult;
export type ImageRequest = import('./contracts.generated.ts').EditRequest | import('./contracts.generated.ts').GenerateRequest;

export interface OperationRefusal {
  status: 'refused';
  code: 'OUTPUT_CONFLICT' | 'INPUTS_CHANGED' | 'DESTINATION_CHANGED';
  message: string;
  effect: import('./errors.ts').ErrorEffect;
  subject: string;
  details: import('./errors.ts').ErrorDetails;
}
export type ImageOutcome = import('./contracts.generated.ts').EditResult | OperationRefusal;
