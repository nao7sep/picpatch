/** Pane floors in CSS pixels; the window minimum is derived from them, never typed separately. */
export const layout = { rail: 200, railDefault: 264, railMax: 440, stage: 480, options: 304, splitter: 6, header: 52, transcript: 200, composer: 132 };
export const minimum = (options: boolean) => ({ width: layout.rail + layout.splitter + layout.stage + (options ? layout.options : 0), height: layout.header + layout.transcript + layout.composer });
/** The rail renders at its dragged intent, narrowed only as far as the stage and options pane need. */
export function railWidth(intent: number | undefined, windowWidth: number, options: boolean): number {
  const fit = windowWidth - layout.splitter - layout.stage - (options ? layout.options : 0);
  return Math.max(layout.rail, Math.min(intent ?? layout.railDefault, layout.railMax, fit));
}
