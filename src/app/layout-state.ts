import { readFile } from 'node:fs/promises';
import { writeJson } from './files.ts';
import { layout } from '../shared/layout.ts';
export interface PaneState { requestWidth: number; sidebar: boolean }
export const initialPaneState = (): PaneState => ({ requestWidth: layout.request, sidebar: false });
export async function readPaneState(path: string): Promise<PaneState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isFinite(value.requestWidth) || value.requestWidth < layout.request || typeof value.sidebar !== 'boolean') return initialPaneState();
    return { requestWidth: value.requestWidth, sidebar: value.sidebar };
  } catch { return initialPaneState(); } // Disposable layout must never prevent opening authored work.
}
export async function savePaneState(path: string, state: PaneState) {
  if (!Number.isFinite(state.requestWidth) || state.requestWidth < layout.request || typeof state.sidebar !== 'boolean') throw new Error('Invalid pane layout.');
  await writeJson(path, state);
}
