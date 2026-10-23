import { maskToOverlay, overlayToMask } from './pixels.ts';

export type MaskCommand =
  | { kind: 'init'; canvas: OffscreenCanvas; mask?: ImageBitmap }
  | { kind: 'begin' }
  | { kind: 'stroke'; point: { x: number; y: number }; width: number; erase: boolean }
  | { kind: 'end' }
  | { kind: 'undo' | 'redo' | 'clear' | 'encode' };
export interface MaskResult { undo: boolean; redo: boolean; bytes?: Uint8Array<ArrayBuffer> | null }

/** This owner only runs inside the worker. Full-size readback, snapshots and
 * conversion therefore never compete with the renderer's pointer dispatch. */
export class MaskEditor {
  private canvas!: OffscreenCanvas;
  private context!: OffscreenCanvasRenderingContext2D;
  private undo: ImageData[] = [];
  private redo: ImageData[] = [];
  private last?: { x: number; y: number };
  // Retain at least one stroke even when its source exceeds the history budget.
  private readonly historyBytes = 64 * 1024 * 1024;

  async run(command: MaskCommand): Promise<MaskResult> {
    switch (command.kind) {
      case 'init': {
        this.canvas = command.canvas;
        this.context = command.canvas.getContext('2d', { willReadFrequently: true })!;
        if (command.mask) {
          try {
            this.context.drawImage(command.mask, 0, 0, this.canvas.width, this.canvas.height);
            const pixels = this.snapshot(); maskToOverlay(pixels.data); this.context.putImageData(pixels, 0, 0);
          } finally { command.mask.close(); }
        }
        break;
      }
      case 'begin': this.remember(); this.last = undefined; break;
      case 'end': this.last = undefined; break;
      case 'stroke': {
        const ctx = this.context, point = command.point;
        ctx.globalCompositeOperation = command.erase ? 'destination-out' : 'source-over';
        ctx.strokeStyle = '#f2a65a'; ctx.fillStyle = '#f2a65a'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = command.width;
        ctx.beginPath(); ctx.moveTo(this.last?.x ?? point.x, this.last?.y ?? point.y); ctx.lineTo(point.x, point.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(point.x, point.y, command.width / 2, 0, Math.PI * 2); ctx.fill();
        this.last = point;
        break;
      }
      case 'clear': this.remember(); this.context.clearRect(0, 0, this.canvas.width, this.canvas.height); break;
      case 'undo': case 'redo': {
        const from = command.kind === 'undo' ? this.undo : this.redo;
        const to = command.kind === 'undo' ? this.redo : this.undo;
        const previous = from.pop();
        if (previous) { to.push(this.snapshot()); this.context.putImageData(previous, 0, 0); }
        this.last = undefined;
        break;
      }
      case 'encode': {
        const pixels = this.snapshot();
        if (!overlayToMask(pixels.data)) return { ...this.state(), bytes: null };
        const output = new OffscreenCanvas(this.canvas.width, this.canvas.height);
        output.getContext('2d')!.putImageData(pixels, 0, 0);
        const blob = await output.convertToBlob({ type: 'image/png' });
        return { ...this.state(), bytes: new Uint8Array(await blob.arrayBuffer()) };
      }
    }
    return this.state();
  }

  private snapshot() { return this.context.getImageData(0, 0, this.canvas.width, this.canvas.height); }
  private state(): MaskResult { return { undo: this.undo.length > 0, redo: this.redo.length > 0 }; }
  private remember() {
    this.undo.push(this.snapshot()); this.redo = [];
    while (this.undo.length > 1 && this.undo.length * this.canvas.width * this.canvas.height * 4 > this.historyBytes) this.undo.shift();
  }
}
