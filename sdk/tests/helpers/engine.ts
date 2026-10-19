import { fileURLToPath } from 'node:url';
import type { ImageClientOptions } from '../../src/index.ts';

export const testEngineDirectory = process.env.PICPATCH_TEST_ENGINE_DIR ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/managed-engine', import.meta.url));
/** Old fixture files also hold a Python path for direct installed-API probes; that is not an editor setting. */
export function inferenceOptions(config: ImageClientOptions): ImageClientOptions {
  const { model, defaults, timeouts } = config;
  return { engineDirectory: testEngineDirectory, ...(model ? { model } : {}), ...(defaults ? { defaults } : {}), ...(timeouts ? { timeouts } : {}) };
}
