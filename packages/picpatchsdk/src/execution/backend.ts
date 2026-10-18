import type { ImageRequest, GenerateRequest, EditRequest, EditResult, ModelCapabilities, OperationOptions } from '../types.ts';

export interface EditBackend {
  /** Check advertised metadata before image I/O; does not load model weights. */
  validate(request: ImageRequest, options?: OperationOptions): Promise<ModelCapabilities>;
  generate(request: GenerateRequest, options?: OperationOptions): Promise<EditResult>;
  edit(request: EditRequest, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
