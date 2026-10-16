/** Run against explicitly supplied local files and a prepared inference environment. */
import { readFile } from 'node:fs/promises';
import { createEditor, type EditorOptions, type EditRequest } from '../src/index.ts';
const [optionsPath, requestPath] = process.argv.slice(2);
if (!optionsPath || !requestPath) throw new Error('Supply editor-options.json and edit-request.json paths.');
const options = JSON.parse(await readFile(optionsPath, 'utf8')) as EditorOptions;
const request = JSON.parse(await readFile(requestPath, 'utf8')) as EditRequest;
const editor = createEditor(options);
try {
  const result = await editor.edit(request, { onProgress: event => console.error(event.message) });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await editor.dispose();
}
