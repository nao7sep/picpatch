/** A first edit using catalog preparation, session defaults and existing local files. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createEditor, listModels, prepareModel } from '../src/index.ts';
const { values } = parseArgs({ options: {
  instruction: { type: 'string' }, source: { type: 'string' }, directory: { type: 'string' }, python: { type: 'string' },
} });
if (!values.instruction || !values.source) throw new Error('Supply --instruction and --source. Optionally select an existing model with --directory and prepared interpreter with --python.');
const choice = listModels()[0]!;
const prepared = await prepareModel(choice.id, values.directory ? { directory: resolve(values.directory) } : {});
const editor = createEditor({ model: prepared.model, ...(values.python ? { pythonExecutable: resolve(values.python) } : {}) });
try {
  const result = await editor.edit({ instruction: values.instruction, sourceImage: resolve(values.source) }, {
    onProgress: event => console.error(event.message),
  });
  console.log(result.image.path);
} finally { await editor.dispose(); }
