import { isAbsolute } from 'node:path';
import { UiError } from '../shared/i18n/index.ts';
import { normalizeZoom } from '../shared/appearance.ts';
import { readFile } from 'node:fs/promises';
import { writeJson } from './files.ts';
import { layout } from '../shared/layout.ts';
export interface PaneState { requestWidth: number; sidebar: boolean; uiZoom?: number; exportDirectory?: string }
export const initialPaneState = (): PaneState => ({ requestWidth: layout.request, sidebar: false });
export async function readPaneState(path: string): Promise<PaneState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isFinite(value.requestWidth) || value.requestWidth < layout.request || typeof value.sidebar !== 'boolean') return initialPaneState();
    const zoom = normalizeZoom(value.uiZoom);
    return { requestWidth: value.requestWidth, sidebar: value.sidebar, ...(zoom !== 1 ? { uiZoom: zoom } : {}), ...(typeof value.exportDirectory === 'string' && isAbsolute(value.exportDirectory) ? { exportDirectory: value.exportDirectory } : {}) };
  } catch { return initialPaneState(); } // Disposable layout must never prevent opening authored work.
}
export async function savePaneState(path: string, state: PaneState) {
  if (!Number.isFinite(state.requestWidth) || state.requestWidth < layout.request || typeof state.sidebar !== 'boolean') throw new UiError('error.invalid_pane_layout');
  await writeJson(path, state);
}
