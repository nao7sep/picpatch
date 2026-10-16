/** Draft contracts; runtime validation and inference are not implemented. */
export interface ReferenceGroup {
  readonly id: string;
  readonly role: 'subject' | 'object' | 'style' | 'background';
  readonly images: readonly string[];
}

export interface EditRequest {
  readonly model: string;
  readonly instruction: string;
  readonly sourceImage?: string;
  readonly references?: readonly ReferenceGroup[];
  readonly maskImage?: string;
  readonly seed?: number;
}

export interface ImageArtifact {
  readonly path: string;
  readonly mimeType: 'image/png';
}

export interface EditResult {
  readonly image: ImageArtifact;
  readonly model: string;
  readonly seed: number;
}

export interface ProgressEvent {
  readonly stage: 'preparing' | 'loading' | 'editing' | 'saving';
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}
