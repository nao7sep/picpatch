import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { referenceWorkload } from './reference-workload.ts';
import type { EditorOptions } from '../src/index.ts';
const configuration = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
const options = JSON.parse(await readFile(configuration, 'utf8')) as EditorOptions;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'input-size': { type: 'string', default: '512' },
  'output-size': { type: 'string', default: '768' },
  counts: { type: 'string', default: '4,6,4,6,4,6' },
} });
const directory = positionals[0];
if (!directory) throw new Error('Supply an existing output directory.');
const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGTERM', abort);
process.on('SIGINT', abort);
try {
  await referenceWorkload(options, directory, Number(values['input-size']), Number(values['output-size']), values.counts.split(',').map(Number), event => {
    console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'Reference benchmark phase.', ...event }));
  }, controller.signal);
} finally {
  process.off('SIGTERM', abort);
  process.off('SIGINT', abort);
}
