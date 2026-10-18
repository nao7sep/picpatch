import type { ImageRequest, GenerateRequest, EditRequest, ModelCapabilities, OperationOptions } from '../types.ts';
import type { EditResult } from '../contracts.generated.ts';

export interface EditBackend {
  /** Bundled capability admission without starting a runtime. Available on production adapters. */
  describe?(request: ImageRequest): ModelCapabilities;
  /** Check advertised metadata before image I/O; does not load model weights. */
  validate(request: ImageRequest, options?: OperationOptions): Promise<ModelCapabilities>;
  generate(request: GenerateRequest, options?: OperationOptions): Promise<EditResult>;
  edit(request: EditRequest, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
