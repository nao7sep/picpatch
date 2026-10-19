import { nativeVariants } from '../src/backends/stable-diffusion-cpp/models.ts';
import { compile } from 'json-schema-to-typescript';
import { readFile, writeFile } from 'node:fs/promises';
const output = new URL('../src/contracts.generated.ts', import.meta.url);
const schema = JSON.parse(await readFile(new URL('../protocol/contracts.schema.json', import.meta.url), 'utf8'));
const models = JSON.parse(await readFile(new URL('../runtimes/mflux/src/picpatch_worker/backends/models.json', import.meta.url), 'utf8'));
models.push(...JSON.parse(await readFile(new URL('../runtimes/dreamo/src/picpatch_dreamo/models.json', import.meta.url), 'utf8')));
if (JSON.stringify(schema.definitions.LocalModel.properties.variant.enum) !== JSON.stringify([...models.map(model => model.id), ...nativeVariants])) throw new Error('Model variants and contract enum disagree.');
// Cross-field presence rules are runtime constraints, not standalone object types.
delete schema.definitions.EditRequest.anyOf;
const source = await compile(schema, 'Contracts', {
  unreachableDefinitions: true,
  bannerComment: '/* Generated from protocol/contracts.schema.json. Run npm run contracts:generate. */',
});
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== source) throw new Error('Generated contracts are stale.');
} else await writeFile(output, source);
