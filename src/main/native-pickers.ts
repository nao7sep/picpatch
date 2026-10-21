import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { UiError } from '../shared/i18n/index.ts';
import { insideBundle } from './trust.ts';

/** Missing or unavailable locations fall back to an existing ancestor without creating anything. */
async function pickerLocation(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined;
  let candidate = value;
  while (true) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory() || (candidate === value && info.isFile())) return candidate;
    } catch { /* A picker hint is optional, including on an unavailable volume. */ }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

export async function pickPaths(owner: BrowserWindow, properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string, initialPath?: string): Promise<string[]> {
  const defaultPath = await pickerLocation(initialPath);
  const result = await dialog.showOpenDialog(owner, { title, properties, ...(defaultPath ? { defaultPath } : {}) });
  return result.canceled ? [] : result.filePaths;
}

/** A current component is a bundle-relative hint; both the hint and selection stay inside that bundle. */
export async function pickBundleComponent(owner: BrowserWindow, directory: unknown, current: unknown, title: string): Promise<string | undefined> {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new UiError('ui.choose_the_model_bundle_first');
  let initialPath = directory;
  if (typeof current === 'string' && !isAbsolute(current)) {
    const candidate = join(directory, current);
    if (insideBundle(directory, candidate)) initialPath = candidate;
  }
  const file = (await pickPaths(owner, ['openFile'], title, initialPath))[0];
  if (!file) return;
  const path = insideBundle(directory, file);
  if (!path) throw new UiError('ui.choose_a_file_inside_the_selected_bundle');
  return path;
}
