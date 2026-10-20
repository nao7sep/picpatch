import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';

/**
 * The live-test cache (tests-folder-conventions): engines, models, configurations and outputs that persist
 * between runs, in the package's ignored node_modules/.cache. PICPATCH_LIVE_CACHE moves it.
 */
export const liveCacheRoot = resolveRoot();
export const liveCache = (...parts: string[]): string => join(liveCacheRoot, ...parts);

function resolveRoot(): string {
  const chosen = process.env.PICPATCH_LIVE_CACHE;
  if (!chosen) return fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/', import.meta.url));
  if (!isAbsolute(chosen)) throw new Error('PICPATCH_LIVE_CACHE must be an absolute path.');
  return chosen;
}
