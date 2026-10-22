import type { RendererRequest } from './messages.ts';
export interface Bridge {
  call(action: string, payload?: unknown): Promise<any>;
  onCommand(listener: (id: string) => void): () => void;
  onChange(listener: () => void): () => void;
  onQueue(listener: (state: unknown) => void): () => void;
  onManaged(listener: (state: unknown) => void): () => void;
  onRequest(listener: (request: RendererRequest) => Promise<unknown>): void;
  droppedFile(file: File): string;
}
