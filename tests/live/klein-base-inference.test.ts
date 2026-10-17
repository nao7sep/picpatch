import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, prepareModel, type EditorOptions } from 'picpatch';

it('prepares the pinned Base 9B bundle and generates then edits through the public SDK', async () => {
  const configuration = process.env.PICPATCH_KLEIN_BASE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/klein-base-9b-config.json', import.meta.url));
  const options: EditorOptions = JSON.parse(await readFile(configuration, 'utf8'));
  const prepared = await prepareModel('flux2-klein-base-9b-4bit', { directory: options.model!.directory });
  expect(prepared.integrity).toBe('matches-manifest');
  expect(prepared.model.variant).toBe('flux2-klein-base-9b');
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-base9-'));
  // Small-canvas regression checks exercise weights; the separate example uses quality settings.
  const editor = createEditor({ ...options, model: prepared.model, defaults: { size: { width: 256, height: 256 }, seed: 42, outputDirectory: directory, parameters: { steps: 2 } } });
  try {
    const generated = await editor.generate({ prompt: 'A green ceramic mug on a wooden table.', sidecar: {} });
    const original = await readFile(generated.image.path);
    const edited = await editor.edit({ sourceImage: generated.image.path, instruction: 'Change the mug to blue.', sidecar: {} });
    for (const result of [generated, edited]) {
      expect(result.effectiveParameters).toEqual({ steps: 2, guidance: 4, scheduler: 'flow_match_euler_discrete' });
      expect(result.modelRevision).toBe(prepared.model.manifest.source.revision);
      expect(result.loras).toBeUndefined();
      expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      expect(await readFile(result.sidecar!.path, 'utf8')).not.toContain(directory);
    }
    expect(await readFile(generated.image.path)).toEqual(original);
    expect((await sharp(generated.image.path).raw().toBuffer()).equals(await sharp(edited.image.path).raw().toBuffer())).toBe(false);
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 600_000);
