import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEditor, type EditorOptions } from 'picpatchsdk';

// npx tsx examples/outpaint.ts EDITOR_OPTIONS_JSON SOURCE OUTPUT WIDTH HEIGHT LEFT TOP
const [config, source, output, width, height, left, top] = process.argv.slice(2);
if (!config || !source || !output || width === undefined || height === undefined || left === undefined || top === undefined) {
  throw new Error('Supply editor-options JSON, source, output, canvas width/height and source left/top offsets.');
}
const options = JSON.parse(await readFile(resolve(config), 'utf8')) as EditorOptions;
const editor = createEditor(options);
try {
  const result = await editor.edit({ instruction: 'Extend the scene naturally into the added canvas.',
    sourceImage: resolve(source), outputPath: resolve(output),
    outpaint: { size: { width: Number(width), height: Number(height) }, left: Number(left), top: Number(top) },
    sidecar: {},
  });
  if ('status' in result) throw new Error(result.code);
  console.log(JSON.stringify({ image: result.image.path, outpaint: result.outpaint, sidecar: result.sidecar }));
} finally { await editor.dispose(); }
