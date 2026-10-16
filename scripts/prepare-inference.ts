import { parseArgs } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { listModels, prepareModel } from '../src/index.ts';

const { values } = parseArgs({ options: { python: { type: 'string' }, directory: { type: 'string' }, download: { type: 'boolean', default: false } } });
if (!values.python || !isAbsolute(values.python)) throw new Error('Supply --python with the absolute prepared interpreter path.');
const prepared = await prepareModel(listModels()[0]!.id, {
  download: values.download,
  ...(values.directory ? { directory: values.directory } : {}),
});
const cache = fileURLToPath(new URL('../node_modules/.cache/picpatch-live/', import.meta.url));
await mkdir(cache, { recursive: true, mode: 0o700 });
const staging = await mkdtemp(join(cache, '.config-'));
try {
  const path = join(staging, 'config.json');
  await writeFile(path, JSON.stringify({ pythonExecutable: values.python, model: prepared.model }, null, 2) + '\n', { mode: 0o600 });
  await rename(path, join(cache, 'inference-config.json'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log('Verified the pinned model and prepared the local inference test configuration.');
