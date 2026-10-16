import type { DiagnosticOptions } from './diagnostics.ts';
import type { ProgressEvent } from './contracts.generated.ts';
export type { GenerateRequest, EditRequest, EditResult, InputGeometry, ImageArtifact, ImageSize, ModelCapabilities, ProgressEvent, ReferenceGroup } from './contracts.generated.ts';

export interface OperationOptions extends DiagnosticOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** Generation returns the same artifact/provenance, with empty references and inputGeometry. */
export type GenerateResult = import('./contracts.generated.ts').EditResult;
export type ImageRequest = import('./contracts.generated.ts').EditRequest | import('./contracts.generated.ts').GenerateRequest;
