import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compare, type ComparisonCase } from './comparison.ts';

// Caller-owned configuration contains prepared editor options and neutral scenarios.
const [configuration, destination] = process.argv.slice(2);
if (!configuration || !destination) throw new Error('Supply comparison JSON and an existing output directory.');
const cases = JSON.parse(await readFile(resolve(configuration), 'utf8')) as ComparisonCase[];
const directory = resolve(destination);
for (const entry of cases) entry.options = { ...entry.options, defaults: { ...entry.options.defaults, outputDirectory: directory } };
const controller = new AbortController();
const abort = () => controller.abort();
process.on('SIGINT', abort); process.on('SIGTERM', abort);
try {
  await compare(cases, join(directory, 'comparison.jsonl'), controller.signal, event => {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
  });
} finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
