import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createEditor, inspectReadiness, listModels, type LocalEditingModel } from '../../src/index.ts';

// These tests import the real installed family classes but never load synthetic weights.
it.each(['flux1-kontext-dev', 'z-image', 'ernie-image', 'ernie-image-turbo', 'flux1-dev', 'flux1-krea-dev', 'flux1-fill-dev', 'z-image-turbo', 'flux1-schnell', 'flux2-klein-4b', 'flux2-klein-9b', 'flux2-klein-base-4b', 'flux2-klein-base-9b'] as const)('checks installed %s imports and rejects unsupported operations before image I/O', async adapter => {
  const configPath = process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url));
  const { pythonExecutable } = JSON.parse(await readFile(configPath, 'utf8')) as { pythonExecutable: string };
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-family-import-'));
  const bytes = Buffer.from('Import-only fixture; never load as weights.');
  const model: LocalEditingModel = { variant: adapter, directory, quantize: 4, manifest: {
    version: 1, model: adapter, source: { repository: 'fixture', revision: 'a'.repeat(40) },
    components: [{ path: 'fixture.bin', role: 'weights', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  } };
  const editor = createEditor({ pythonExecutable, model });
  try {
    await writeFile(join(directory, 'fixture.bin'), bytes);
    const readiness = await inspectReadiness(pythonExecutable, model);
    expect(readiness.runtime).toMatchObject({ status: 'imports-ready', version: '0.22.0' });
    const fill = adapter === 'flux1-fill-dev';
    const kontext = adapter === 'flux1-kontext-dev';
    const editing = fill || kontext || adapter.startsWith('flux2-klein');
    expect(readiness.capabilities).toEqual([expect.objectContaining({ model: adapter, textToImage: !fill && !kontext,
      instructionEditing: editing, maskMode: fill ? 'native' : adapter.startsWith('flux2-klein') ? 'composite' : 'none' })]);
    if (kontext) await expect(editor.edit({ instruction: 'Use blue.', references: [{ id: 'subject', role: 'subject', images: [join(directory, 'absent.png')] }], outputPath: join(directory, 'edit.png') })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    if (!editing || fill) await expect(editor.edit({ instruction: 'Use blue.', sourceImage: join(directory, 'absent.png'), outputPath: join(directory, 'edit.png') })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(editor.generate({ prompt: 'A bowl.', size: { width: 17, height: 32 }, outputPath: join(directory, 'generate.png') })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await readdir(directory)).toEqual(['fixture.bin']);
    // An implemented experimental adapter is not a tested/acquirable catalog bundle.
    expect(listModels().find(entry => entry.id === adapter)).toMatchObject({ acquisition: 'external', evidence: 'api-tested' });
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
