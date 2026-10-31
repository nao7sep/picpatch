import { isAbsolute } from 'node:path';
import { UiError } from '../../shared/i18n/index.ts';
import { normalizeZoom } from '../../shared/appearance.ts';
import { readFile } from 'node:fs/promises';
import { writeJson } from './files.ts';
import { layout } from '../../shared/layout.ts';
import { appFile, checkFileHeader, fileContent } from './file-header.ts';
export interface PaneState { railWidth: number; optionsPane: boolean; uiZoom?: number; exportDirectory?: string; recordsListWidth?: number }
export const initialPaneState = (): PaneState => ({ railWidth: layout.railDefault, optionsPane: false });
const validRail = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= layout.rail && value <= layout.railMax;
/** Layout files from a newer PicPatch, read as defaults and never saved over. */
const newer = new Set<string>();
export async function readPaneState(path: string): Promise<PaneState> {
  try {
    const document: unknown = JSON.parse(await readFile(path, 'utf8'));
    const header = checkFileHeader(document, 'state');
    if (header.status === 'newer') newer.add(path);
    if (header.status !== 'current') return initialPaneState();
    const value = fileContent<Record<string, any>>(document as object);
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
export function checkPaneState(state: PaneState): void {
  if (!validRail(state.railWidth) || typeof state.optionsPane !== 'boolean') throw new UiError('error.invalid_pane_layout');
}
export async function savePaneState(path: string, state: PaneState) { checkPaneState(state); if (!newer.has(path)) await writeJson(path, appFile('state', state)); }
