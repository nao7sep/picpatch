/** A first edit using catalog preparation, session defaults and existing local files. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createEditor, listModels, prepareModel } from 'picpatchsdk';
const { values } = parseArgs({ options: {
  steps: { type: 'string' }, guidance: { type: 'string' }, instruction: { type: 'string' }, mask: { type: 'string' }, source: { type: 'string' }, output: { type: 'string' }, directory: { type: 'string' }, python: { type: 'string' },
} });
if (!values.instruction || !values.source || !values.output) throw new Error('Supply --instruction, --source and --output. Optionally select an existing model with --directory and prepared interpreter with --python.');
const choice = listModels()[0]!;
const prepared = await prepareModel(choice.id, values.directory ? { directory: resolve(values.directory) } : {});
const editor = createEditor({ model: prepared.model, ...(values.python ? { pythonExecutable: resolve(values.python) } : {}) });
try {
  const result = await editor.edit({ instruction: values.instruction, sourceImage: resolve(values.source), outputPath: resolve(values.output), parameters: {
    ...(values.steps !== undefined ? { steps: Number(values.steps) } : {}),
    ...(values.guidance !== undefined ? { guidance: Number(values.guidance) } : {}),
  }, ...(values.mask ? { maskImage: resolve(values.mask) } : {}) }, {
    onProgress: event => console.error(event.message),
  });
  console.log(result.image.path);
} finally { await editor.dispose(); }
