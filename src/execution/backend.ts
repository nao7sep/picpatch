import type { EditRequest, EditResult, ModelCapabilities, OperationOptions } from '../types.ts';

export interface EditBackend {
  /** Check advertised metadata before image I/O; does not load model weights. */
  validate(request: EditRequest, options?: OperationOptions): Promise<ModelCapabilities>;
  edit(request: EditRequest, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
