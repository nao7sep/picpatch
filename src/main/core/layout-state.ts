import { isAbsolute } from 'node:path';
import { UiError } from '../shared/i18n/index.ts';
import { normalizeZoom } from '../shared/appearance.ts';
import { readFile } from 'node:fs/promises';
import { writeJson } from './files.ts';
import { layout } from '../shared/layout.ts';
export interface PaneState { railWidth: number; optionsPane: boolean; uiZoom?: number; exportDirectory?: string; recordsListWidth?: number }
export const initialPaneState = (): PaneState => ({ railWidth: layout.railDefault, optionsPane: false });
const validRail = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= layout.rail && value <= layout.railMax;
export async function readPaneState(path: string): Promise<PaneState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const zoom = normalizeZoom(value.uiZoom);
    return {
      railWidth: validRail(value.railWidth) ? value.railWidth : layout.railDefault,
      optionsPane: value.optionsPane === true,
      ...(zoom !== 1 ? { uiZoom: zoom } : {}),
      ...(Number.isFinite(value.recordsListWidth) && value.recordsListWidth >= 320 ? { recordsListWidth: value.recordsListWidth } : {}),
      ...(typeof value.exportDirectory === 'string' && isAbsolute(value.exportDirectory) ? { exportDirectory: value.exportDirectory } : {}),
    };
  } catch { return initialPaneState(); } // Disposable layout must never prevent opening authored work.
}
export async function savePaneState(path: string, state: PaneState) {
  if (!validRail(state.railWidth) || typeof state.optionsPane !== 'boolean') throw new UiError('error.invalid_pane_layout');
  await writeJson(path, state);
}
