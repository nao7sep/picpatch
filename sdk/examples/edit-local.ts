/**
 * A first edit using catalog preparation, session defaults and existing local files. Run from sdk/:
 *   node examples/edit-local.ts --instruction TEXT --source IMAGE --output PNG [--mask MASK] [--steps N]
 *     [--guidance G] [--directory MODEL_BUNDLE] [--engine ENGINE_DIR]
 * It downloads nothing: the model must already be prepared, and the managed engine installed.
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createImageClient, listModels, prepareModel } from 'picpatchsdk';
const { values } = parseArgs({ options: {
  steps: { type: 'string' }, guidance: { type: 'string' }, instruction: { type: 'string' }, mask: { type: 'string' }, source: { type: 'string' }, output: { type: 'string' }, directory: { type: 'string' }, engine: { type: 'string' },
} });
if (!values.instruction || !values.source || !values.output) throw new Error('Supply --instruction, --source and --output. Optionally select an existing model with --directory and managed runtime with --engine.');
const choice = listModels()[0]!;
const prepared = await prepareModel(choice.id, values.directory ? { directory: resolve(values.directory) } : {});
const editor = createImageClient({ model: prepared.model, ...(values.engine ? { engineDirectory: resolve(values.engine) } : {}) });
try {
  const result = await editor.edit({ instruction: values.instruction, sourceImage: resolve(values.source), outputPath: resolve(values.output), parameters: {
    ...(values.steps !== undefined ? { steps: Number(values.steps) } : {}),
    ...(values.guidance !== undefined ? { guidance: Number(values.guidance) } : {}),
  }, ...(values.mask ? { maskImage: resolve(values.mask) } : {}) }, {
    onEvent: event => console.error(event.message),
  });
  if (result.status === 'refused') throw new Error(result.code);
  console.log(result.image.path);
} finally { await editor.dispose(); }
