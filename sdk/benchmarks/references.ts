import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { referenceWorkload } from './reference-workload.ts';
import type { ImageClientOptions } from 'picpatchsdk';
import { liveCache } from '../tests/helpers/live-cache.ts';
const configuration = process.env.PICPATCH_INFERENCE_CONFIG ?? liveCache('inference-config.json');
const options = JSON.parse(await readFile(configuration, 'utf8')) as ImageClientOptions;
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
