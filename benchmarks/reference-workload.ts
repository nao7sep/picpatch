import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { createEditor, type EditorOptions, type ReferenceGroup } from '../src/index.ts';

// Synthetic object views isolate reference-count and resource behavior from likeness.
export async function referenceWorkload(options: EditorOptions, directory: string,
  inputSize: number, outputSize: number, counts: readonly number[],
  record: (event: Record<string, unknown>) => void = () => {}, signal?: AbortSignal) {
  assert(options.model, 'Supply a prepared local inference configuration.');
  const groups: string[][] = [[], []];
  for (let group = 0; group < 2; group++) {
    for (let view = 0; view < 3; view++) {
      const path = join(directory, `reference-${group}-${view}.png`);
      const object = group === 0
        ? '<ellipse cx="256" cy="285" rx="110" ry="95" fill="#c32632"/><path d="M160 260 L85 190 L115 310" fill="#c32632"/><ellipse cx="256" cy="200" rx="65" ry="15" fill="#951d26"/><path d="M350 235 C450 205 440 350 350 330" fill="none" stroke="#951d26" stroke-width="20"/>'
        : '<rect x="155" y="155" width="202" height="250" rx="45" fill="#e4b52b"/><rect x="185" y="285" width="142" height="85" rx="20" fill="#a98119"/><path d="M215 160 V115 H297 V160" fill="none" stroke="#493c20" stroke-width="18"/>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#eeeeea"/><g transform="translate(${view * 8 - 8} 0) rotate(${view * 6 - 6} 256 256)">${object}</g></svg>`;
      await sharp(Buffer.from(svg)).resize(inputSize, inputSize).png().toFile(path);
      groups[group]!.push(path);
    }
  }
  const hashes = await Promise.all(groups.flat().map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
  const editor = createEditor(options);
  try {
    for (const [index, count] of counts.entries()) {
      assert(count === 4 || count === 6);
      const groupReference = (group: number): ReferenceGroup => ({ id: `object-${group}`, role: 'object', images: groups[group]!.slice(0, count / 2) as [string, ...string[]] });
      const references: [ReferenceGroup, ReferenceGroup] = [groupReference(0), groupReference(1)];
      const outputPath = join(directory, `output-${index}.png`);
      const started = performance.now();
      record({ kind: 'start', index, count });
      const result = await editor.edit({ model: options.model.manifest.model,
        instruction: 'Place the red teapot and the yellow backpack together on a wooden table. Each group shows different views of one object. Show exactly one of each object, preserving their colors and shapes. Natural product photograph.',
        references, outputPath, seed: 42, size: { width: outputSize, height: outputSize } }, signal ? { signal } : {});
      const metadata = await sharp(result.image.path).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, outputSize);
      assert.equal(metadata.height, outputSize);
      await sharp(outputPath).raw().toBuffer();
      assert.deepEqual(result.references, references);
      assert.equal(result.modelRevision, options.model.manifest.source.revision);
      assert.equal(result.seed, 42);
      assert.equal(result.cleanupWarning, undefined);
      assert.deepEqual(await Promise.all(groups.flat().map(async path => createHash('sha256').update(await readFile(path)).digest('hex'))), hashes);
      assert.equal((await readdir(directory)).length, 6 + index + 1, 'Private workspaces must be cleaned before success.');
      record({ kind: 'end', index, count, seconds: (performance.now() - started) / 1000 });
      // Observe settled worker memory between operations, rather than only allocation peaks.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    await editor.dispose();
    record({ kind: 'disposed' });
  }
}
