import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel } from 'picpatchsdk';
import { loraWeights } from '../helpers/lora-weights.ts';
import { nativeInferenceConfigPath } from '../helpers/live-cache.ts';

it('runs Canny generation and source editing with local LoRA composition and path-free provenance', async () => {
  const config = JSON.parse(await readFile(nativeInferenceConfigPath(), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-control-inference-'));
  try {
    await symlink(join(config.directory, config.sd15Checkpoint), join(directory, 'base.safetensors'));
    await symlink(join(config.directory, config.controlNet), join(directory, 'canny.safetensors'));
    await loraWeights(join(directory, 'adapter.safetensors'));
    const map = join(directory, 'edges.png');
    const pixels = Buffer.alloc(256 * 256);
    for (let y = 48; y < 208; y++) for (let x = 48; x < 208; x++) if (x < 51 || x > 204 || y < 51 || y > 204) pixels[y * 256 + x] = 255;
    await sharp(pixels, { raw: { width: 256, height: 256, channels: 1 } }).toColourspace('b-w').png().toFile(map);
    const original = await readFile(map);
    const prepared = await prepareModel('sd15', { directory, checkpoint: 'base.safetensors', controlNet: { kind: 'canny', path: 'canny.safetensors' }, loras: [{ path: 'adapter.safetensors', scale: 0.5 }] });
    const editor = createImageClient({ model: prepared.model, nativeExecutable: config.executable, defaults: { outputDirectory: directory, size: { width: 256, height: 256 }, seed: 42, parameters: { steps: 4 } } });
    try {
      const outputs: string[] = [];
      for (const strength of [0, 1]) {
        const result = await editor.generate({ prompt: 'A square blue ceramic tile on a table.', control: { kind: 'canny', image: map, strength }, record: { includeInputs: true }, sidecar: true });
        if (result.status === 'refused') throw new Error(result.code);
        expect(result.control).toMatchObject({ kind: 'canny', strength, asset: { filename: 'canny.safetensors', sha256: '8932b66e15aae835b3490dbf989f56c253104cee08a88bf21283762f557c9f10' } });
        expect(result.loras?.[0]?.scale).toBe(0.5);
        expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
        const sidecar = await readFile(result.sidecar!.path, 'utf8');
        expect(sidecar).not.toContain(directory);
        expect(JSON.parse(sidecar)).toMatchObject({ control: result.control, inputs: { controlImage: 'edges.png' } });
        outputs.push(result.image.path);
      }
      expect((await sharp(outputs[0]!).raw().toBuffer()).equals(await sharp(outputs[1]!).raw().toBuffer())).toBe(false);
      const request = { instruction: 'A green ceramic tile on a table.', sourceImage: outputs[1]!, control: { kind: 'canny' as const, image: map }, parameters: { strength: 0.8 }, sidecar: true };
      const abort = new AbortController();
      await expect(editor.edit(request, { signal: abort.signal, onEvent: event => { if (event.stage === 'editing') abort.abort(); } })).rejects.toMatchObject({ code: 'CANCELLED' });
      const edit = await editor.edit(request);
      if (edit.status === 'refused') throw new Error(edit.code);
      expect(edit.control?.strength).toBe(0.9);
      expect((await sharp(edit.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      const record = JSON.parse(await readFile(edit.sidecar!.path, 'utf8'));
      expect(record.inputs).toBeUndefined();
      expect(record.control).toEqual(edit.control);
      expect(await readFile(map)).toEqual(original);
      expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
    } finally { await editor.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
