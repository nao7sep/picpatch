import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { referenceWorkload } from './reference-workload.ts';
import type { EditorOptions } from '../src/index.ts';
const configuration = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
const options = JSON.parse(await readFile(configuration, 'utf8')) as EditorOptions;
const directory = process.argv[2];
if (!directory) throw new Error('Supply an existing output directory.');
const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGTERM', abort);
process.on('SIGINT', abort);
try {
  await referenceWorkload(options, directory, 512, 768, [4, 6, 4, 6, 4, 6], event => {
    console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'Reference benchmark phase.', ...event }));
  }, controller.signal);
} finally {
  process.off('SIGTERM', abort);
  process.off('SIGINT', abort);
}
