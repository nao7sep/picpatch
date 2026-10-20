import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The live cache the app's live lanes read prepared engines, models and configurations from, ignored
 * so nothing a test writes can be committed. PICPATCH_LIVE_CACHE chooses it; by default it is the one the picpatchsdk
 * package's live lane fills, found by resolving the package by name rather than by a path into it.
 */
export const liveCacheRoot = resolveRoot();
export const liveCache = (...parts: string[]): string => join(liveCacheRoot, ...parts);
/** The app's own live outputs, in this package's ignored cache. */
// From this file's own path: a DOM test environment replaces the global URL, so no URL is resolved here.
export const appLiveCache = (...parts: string[]): string => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache', 'picpatch-live', ...parts);

function resolveRoot(): string {
  const chosen = process.env.PICPATCH_LIVE_CACHE;
  if (chosen) {
    if (!isAbsolute(chosen)) throw new Error('PICPATCH_LIVE_CACHE must be an absolute path.');
    return chosen;
  }
  return join(dirname(fileURLToPath(import.meta.resolve('picpatchsdk/package.json'))), 'node_modules', '.cache', 'picpatch-live');
}
