// The minimal Windows proof: the pinned native engine installs through the product's own path,
// SD 1.5 registers from the developer's files, and one small image generates. Run on Windows with
//   npx vitest run --config vitest.live.config.ts tests/live/windows-native.test.ts
// after saving { "directory": "<folder>", "checkpoint": "v1-5-pruned-emaonly-fp16.safetensors" }
// as windows-native-config.json in the live cache (or naming it in PICPATCH_WINDOWS_NATIVE_CONFIG).
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createImageClient, installNativeEngine, prepareModel } from 'picpatchsdk';
import { liveCache } from '../helpers/live-cache.ts';

it.skipIf(process.platform !== 'win32')('installs the native engine and generates with SD 1.5 on Windows', async () => {
  const path = process.env.PICPATCH_WINDOWS_NATIVE_CONFIG ?? liveCache('windows-native-config.json');
  let config: { directory: string; checkpoint: string };
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (cause) { throw new Error(`Save { "directory", "checkpoint" } for the SD 1.5 fp16 checkpoint at ${path}. This test never downloads weights.`, { cause }); }
  const engine = await installNativeEngine({ engineDirectory: liveCache('windows-engine') });
  expect(engine.status).toBe('ready');
  const { model } = await prepareModel('sd15', { directory: config.directory, checkpoint: config.checkpoint });
  const output = await mkdtemp(join(tmpdir(), 'picpatch-windows-native-'));
  const editor = createImageClient({ model, nativeExecutable: engine.nativeExecutable });
  try {
    const started = performance.now();
    const result = await editor.generate({ prompt: 'A red apple on a wooden table.', outputPath: join(output, 'apple.png'), size: { width: 256, height: 256 }, seed: 1, parameters: { steps: 4 } });
    if (result.status === 'refused') throw new Error(result.code);
    expect((await stat(result.image.path)).size).toBeGreaterThan(0);
    console.info(`Generated 256x256 at 4 steps in ${Math.round((performance.now() - started) / 1000)} s.`);
  } finally { await editor.dispose(); await rm(output, { recursive: true, force: true }); }
});
