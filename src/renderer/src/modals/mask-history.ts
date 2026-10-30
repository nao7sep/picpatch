// Paint mask's undo and redo. Each entry holds only the region one stroke (or Clear)
// changed, as it was before, so a large image keeps as many steps as a small one.

export type Rect = { x: number; y: number; width: number; height: number };
export type Region<T> = { rect: Rect; pixels: T };
/** The painted layer, read and written by region. */
export type Surface<T> = { read(rect: Rect): T; write(region: Region<T>): void };

/** Grows a stroke's bounds by a brush dab at (x, y). */
export function extend(bounds: Rect | undefined, x: number, y: number, radius: number): Rect {
  const left = x - radius, top = y - radius, right = x + radius, bottom = y + radius;
  if (!bounds) return { x: left, y: top, width: right - left, height: bottom - top };
  const x0 = Math.min(bounds.x, left), y0 = Math.min(bounds.y, top);
  return { x: x0, y: y0, width: Math.max(bounds.x + bounds.width, right) - x0, height: Math.max(bounds.y + bounds.height, bottom) - y0 };
}

/** Whole pixels covering the bounds, with one pixel of antialiasing, inside the image; undefined when nothing is inside. */
export function pixelRect(bounds: Rect, size: { width: number; height: number }): Rect | undefined {
  const x0 = Math.max(0, Math.floor(bounds.x) - 1), y0 = Math.max(0, Math.floor(bounds.y) - 1);
  const x1 = Math.min(size.width, Math.ceil(bounds.x + bounds.width) + 1), y1 = Math.min(size.height, Math.ceil(bounds.y + bounds.height) + 1);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

export class MaskHistory<T> {
  private undoStack: Region<T>[] = [];
  private redoStack: Region<T>[] = [];
  constructor(private readonly surface: Surface<T>) {}
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  /** A finished change, given as its region before the change. */
  record(before: Region<T>) { this.undoStack.push(before); this.redoStack = []; }
  /** Puts back the last change's region, keeping what it replaces for the other direction. */
  step(from: 'undo' | 'redo'): boolean {
    const stack = from === 'undo' ? this.undoStack : this.redoStack, other = from === 'undo' ? this.redoStack : this.undoStack;
    const region = stack.pop(); if (!region) return false;
    other.push({ rect: region.rect, pixels: this.surface.read(region.rect) });
    this.surface.write(region);
    return true;
  }
}
