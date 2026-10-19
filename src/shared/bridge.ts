export interface Bridge {
  call(action: string, payload?: unknown): Promise<any>;
  onCommand(listener: (id: string) => void): () => void;
  onChange(listener: () => void): () => void;
  onFlush(listener: () => Promise<void>): void;
  droppedFile(file: File): string;
}
