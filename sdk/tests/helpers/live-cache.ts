import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * The live-test cache: engines, models, configurations and outputs that persist between runs, in the
 * package's ignored node_modules/.cache, so nothing a test writes can be committed. PICPATCH_LIVE_CACHE moves it.
 */
export const liveCacheRoot = resolveRoot();
export const liveCache = (...parts: string[]): string => join(liveCacheRoot, ...parts);

function resolveRoot(): string {
  const chosen = process.env.PICPATCH_LIVE_CACHE;
  if (!chosen) return fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/', import.meta.url));
  if (!isAbsolute(chosen)) throw new Error('PICPATCH_LIVE_CACHE must be an absolute path.');
  return chosen;
}

/**
 * The configuration the native live tests read: PICPATCH_NATIVE_INFERENCE_CONFIG, or native-inference-config.json in
 * the live cache. It names the model directory, the sd-cli executable and the asset files. Prepare the exact assets
 * pinned in tests/fixtures/native-sdxl-assets.json and native-sd15-assets.json from their pinned Hugging Face
 * revisions, outside tracked source; each keeps its upstream licence.
 */
export const nativeInferenceConfigPath = (): string => process.env.PICPATCH_NATIVE_INFERENCE_CONFIG ?? liveCache('native-inference-config.json');

/**
 * The managed-engine inference configuration the MFLUX live tests read: PICPATCH_INFERENCE_CONFIG, or
 * inference-config.json in the live cache. The tests never download models, so a missing file names the
 * script that prepares it.
 */
export async function inferenceConfig<T = Record<string, any>>(): Promise<T> {
  const path = process.env.PICPATCH_INFERENCE_CONFIG ?? liveCache('inference-config.json');
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    throw new Error(`${path} is missing. Install the managed engine, then run node scripts/prepare-inference.ts from sdk/ (sdk/scripts/prepare-inference.ts) to write it, or set PICPATCH_INFERENCE_CONFIG.`, { cause });
  }
  return JSON.parse(text) as T;
}
