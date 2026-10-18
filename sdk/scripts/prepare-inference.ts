import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { inspectEngine, listModels, prepareModel } from 'picpatchsdk';

const { values } = parseArgs({ options: { engine: { type: 'string' }, directory: { type: 'string' }, download: { type: 'boolean', default: false }, model: { type: 'string' }, output: { type: 'string' } } });
if (values.output && !isAbsolute(values.output)) throw new Error('Supply --output with an absolute configuration file path.');
const engine = await inspectEngine(values.engine ? { engineDirectory: values.engine } : {});
if (engine.status !== 'ready') throw new Error('Install the managed engine before preparing inference fixtures.');
const prepared = await prepareModel(values.model ?? listModels()[0]!.id, {
  download: values.download,
  ...(values.directory ? { directory: values.directory } : {}),
});
const cache = fileURLToPath(new URL('../node_modules/.cache/picpatch-live/', import.meta.url));
await mkdir(cache, { recursive: true, mode: 0o700 });
const staging = await mkdtemp(join(cache, '.config-'));
try {
  const path = join(staging, 'config.json');
  await writeFile(path, JSON.stringify({ engineDirectory: engine.engineDirectory, pythonExecutable: engine.pythonExecutable, model: prepared.model }, null, 2) + '\n', { mode: 0o600 });
  await rename(path, values.output ?? join(cache, 'inference-config.json'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log('Verified the pinned model and prepared the local inference test configuration.');
