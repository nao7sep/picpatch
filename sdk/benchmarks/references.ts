// Runs the synthetic grouped-reference workload (reference-workload.ts) with the managed-engine configuration the
// live tests use (scripts/prepare-inference.ts), by hand on a prepared machine:
//   node benchmarks/references.ts /absolute/output-directory [--input-size 512] [--output-size 768] [--counts 4,6,4,6,4,6]
import { parseArgs } from 'node:util';
import { referenceWorkload } from './reference-workload.ts';
import type { ImageClientOptions } from 'picpatchsdk';
import { inferenceConfig } from '../tests/helpers/live-cache.ts';
const options = await inferenceConfig<ImageClientOptions>();
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
