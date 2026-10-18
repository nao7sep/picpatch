import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEditor, type EditorOptions } from 'picpatchsdk';

// npx tsx examples/artifact-sidecar.ts EDITOR_OPTIONS_JSON OUTPUT_PNG
// Options point to an already prepared model/runtime; this example downloads nothing.
const [configuration, destination] = process.argv.slice(2);
if (!configuration || !destination) throw new Error('Supply editor-options JSON and an output PNG path.');
const options = JSON.parse(await readFile(resolve(configuration), 'utf8')) as EditorOptions;
const editor = createEditor(options);
try {
  const result = await editor.generate({
    prompt: 'A blue ceramic bowl on a plain white table.', outputPath: resolve(destination),
    sidecar: {}, // Use { includeInputs: true } only when prompt/input retention is wanted.
  });
  if ('status' in result) throw new Error(result.code);
  console.log(JSON.stringify({ image: result.image.path, sidecar: result.sidecar }));
  if (result.sidecar?.status === 'failed') process.exitCode = 1; // The PNG remains saved.
} finally { await editor.dispose(); }
