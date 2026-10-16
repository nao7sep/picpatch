import type { EditRequest, EditResult, OperationOptions } from './types.ts';

/** Planned public surface. There is deliberately no fake editor implementation. */
export interface Editor {
  edit(request: EditRequest, options?: OperationOptions): Promise<EditResult>;
  dispose(): Promise<void>;
}
