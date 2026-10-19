import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A folder under the platform's cache location, outside the repository, so no clean, reinstall or commit can delete or capture it. */
export function cacheFolder(name: string, ...parts: string[]): string {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, name, ...parts);
}

/** The live-test cache: engines, models, configurations and outputs that persist between runs. PICPATCH_LIVE_CACHE moves it. */
export const liveCacheRoot = resolveRoot();
export const liveCache = (...parts: string[]): string => join(liveCacheRoot, ...parts);

function resolveRoot(): string {
  const chosen = process.env.PICPATCH_LIVE_CACHE;
  if (!chosen) return cacheFolder('picpatch-live');
  if (!isAbsolute(chosen)) throw new Error('PICPATCH_LIVE_CACHE must be an absolute path.');
  return chosen;
}
