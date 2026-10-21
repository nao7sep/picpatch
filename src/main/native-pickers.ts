import { stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';

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
