// Compares PicPatchSdk's image clients on caller-owned cases, run by hand on a prepared machine:
//   node benchmarks/compare-local.ts /absolute/cases.json /absolute/output-directory
// cases.json lists cases, each with an ID, prepared image-client options and ordered generate or edit operations;
// sourceFromPrevious: true chains an edit onto the previous result. It acquires no models. One versioned JSONL
// ComparisonRecord is appended per settled operation (see comparison.ts); prompts and paths are left out, an
// existing report is never overwritten, and an unsupported combination is recorded rather than translated. Equal
// seeds across models do not imply equal noise. benchmarks/measure.py can run it while sampling memory.
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
