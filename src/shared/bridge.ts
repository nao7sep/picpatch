export interface Bridge {
  call(action: string, payload?: unknown): Promise<any>;
  onChange(listener: () => void): () => void;
  onFlush(listener: () => Promise<void>): void;
  droppedFile(file: File): string;
}
