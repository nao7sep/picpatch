// Writes the managed-engine inference configuration the MFLUX live tests, examples and benchmarks read. Run from sdk/
// once the managed engine is installed:
//   node scripts/prepare-inference.ts [--engine /absolute/engine-directory] [--model flux2-klein-4b-4bit]
//     [--download] [--directory /absolute/model-bundle] [--output /absolute/config.json]
// It verifies the pinned model, downloading it only with --download, and records the engine and model to use;
// the configuration goes to inference-config.json in the live cache unless --output names another file.
import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { inspectEngine, listModels, prepareModel } from 'picpatchsdk';
import { liveCacheRoot } from '../tests/helpers/live-cache.ts';

const { values } = parseArgs({ options: { engine: { type: 'string' }, directory: { type: 'string' }, download: { type: 'boolean', default: false }, model: { type: 'string' }, output: { type: 'string' } } });
if (values.output && !isAbsolute(values.output)) throw new Error('Supply --output with an absolute configuration file path.');
const engine = await inspectEngine(values.engine ? { engineDirectory: values.engine } : {});
if (engine.status !== 'ready') throw new Error('Install the managed engine before preparing inference fixtures.');
const prepared = await prepareModel(values.model ?? listModels()[0]!.id, {
  download: values.download,
  ...(values.directory ? { directory: values.directory } : {}),
});
const cache = liveCacheRoot;
await mkdir(cache, { recursive: true, mode: 0o700 });
const staging = await mkdtemp(join(cache, '.config-'));
try {
  const path = join(staging, 'config.json');
  await writeFile(path, JSON.stringify({ engineDirectory: engine.engineDirectory, pythonExecutable: engine.pythonExecutable, model: prepared.model }, null, 2) + '\n', { mode: 0o600 });
  await rename(path, values.output ?? join(cache, 'inference-config.json'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log('Verified the pinned model and prepared the local inference test configuration.');
