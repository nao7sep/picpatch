import { isAbsolute } from 'node:path';
import { UiError } from '../../shared/i18n/index.ts';
import { normalizeZoom } from '../../shared/appearance.ts';
import { readFileSync } from 'node:fs';
import { writeJson } from './files.ts';
import { layout } from '../../shared/layout.ts';
import { appFile, checkBeforeWrite, checkFileHeader, fileContent } from './file-header.ts';
import { refused, RefusedFiles } from './refused-files.ts';
export interface PaneState { railWidth: number; optionsPane: boolean; uiZoom?: number; exportDirectory?: string; recordsListWidth?: number }
export const initialPaneState = (): PaneState => ({ railWidth: layout.railDefault, optionsPane: false });
const validRail = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= layout.rail && value <= layout.railMax;
/**
 * Read at launch. Layout is disposable: a missing or unreadable state.json takes the defaults with no notice, and the
 * next save replaces it. One a newer PicPatch wrote is refused, which stops the launch.
 */
export function readPaneState(path: string): PaneState {
  let document: unknown;
  try { document = JSON.parse(readFileSync(path, 'utf8')); } catch { return initialPaneState(); }
  const header = checkFileHeader(document, 'state');
  if (header.status === 'newer') throw refused(path, true);
  if (header.status !== 'current') return initialPaneState();
  try {
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
/** Layout files whose saves are refused; each is reported once and never retried. */
const refusedSaves = new Set<string>();
export async function savePaneState(path: string, state: PaneState) {
  checkPaneState(state);
  if (refusedSaves.has(path)) return;
  // Guarded at the write: a state.json a newer PicPatch wrote since launch stays as it is.
  try { await checkBeforeWrite(path, 'state', true); }
  catch (error) { if (error instanceof RefusedFiles) refusedSaves.add(path); throw error; }
  await writeJson(path, appFile('state', state));
}
