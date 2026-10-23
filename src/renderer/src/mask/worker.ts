import { MaskEditor, type MaskCommand, type MaskResult } from './editor.ts';

export type MaskRequest = { id: number; command: MaskCommand };
export type MaskReply = { id: number; result: MaskResult } | { id: number; error: { message: string; stack?: string } };

// The serial tail includes asynchronous PNG encoding. A later command and owner
// disposal cannot overtake an accepted command that is still producing bytes.
const editor = new MaskEditor();
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<MaskRequest>) => void;
  postMessage: (reply: MaskReply, transfer: Transferable[]) => void;
};
let tail = Promise.resolve();
scope.onmessage = ({ data }) => {
  tail = tail.then(async () => {
    try {
      const result = await editor.run(data.command);
      scope.postMessage({ id: data.id, result }, result.bytes ? [result.bytes.buffer] : []);
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value));
      scope.postMessage({ id: data.id, error: { message: error.message, stack: error.stack } }, []);
    }
  });
};
