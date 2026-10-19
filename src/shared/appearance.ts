export const defaultFont = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const fixedFont = 'ui-monospace, "Menlo", "Consolas", monospace';
export function normalizeZoom(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 3 ? value : 1; }
export function nextZoom(value: number, direction: 'in' | 'out' | 'reset'): number {
  return direction === 'reset' ? 1 : Math.min(3, Math.max(0.5, Math.round(value * (direction === 'in' ? 1.2 : 1 / 1.2) * 1000) / 1000));
}
/** CSS content floors become native logical sizes; never demand more than the work area. */
export function windowMinimum(content: { width: number; height: number }, zoom: number, frame: { width: number; height: number }, workArea: { width: number; height: number }) {
  return { width: Math.min(workArea.width, Math.ceil(content.width * zoom + frame.width)), height: Math.min(workArea.height, Math.ceil(content.height * zoom + frame.height)) };
}
