import type { ImageClientOptions } from '../../src/index.ts';
import { liveCache } from './live-cache.ts';

export const testEngineDirectory = process.env.PICPATCH_TEST_ENGINE_DIR ?? liveCache('managed-engine');
/** Old fixture files also hold a Python path for direct installed-API probes; that is not an editor setting. */
export function inferenceOptions(config: ImageClientOptions): ImageClientOptions {
  const { model, defaults, timeouts } = config;
  return { engineDirectory: testEngineDirectory, ...(model ? { model } : {}), ...(defaults ? { defaults } : {}), ...(timeouts ? { timeouts } : {}) };
}
