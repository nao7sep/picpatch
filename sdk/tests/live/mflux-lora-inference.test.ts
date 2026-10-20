import { testEngineDirectory } from '../helpers/engine.ts';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel, type ImageClientOptions } from 'picpatchsdk';
import { kleinLoraWeights } from '../helpers/lora-weights.ts';
import { liveCache } from '../helpers/live-cache.ts';

it('applies local LoRAs to real quantized Klein generation and editing without baking or leaking paths', async () => {
  const config: ImageClientOptions = JSON.parse(await readFile(process.env.PICPATCH_INFERENCE_CONFIG ?? liveCache('inference-config.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-mflux-lora-'));
  try {
    for (const component of config.model!.manifest.components) {
      const target = join(directory, component.path);
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(config.model!.directory, component.path), target);
    }
    await kleinLoraWeights(join(directory, 'adapter.safetensors'));
    const original = await readFile(join(directory, 'adapter.safetensors'));
    const prepared = await prepareModel(config.model!.manifest.model, { directory, loras: [{ path: 'adapter.safetensors' }] });
    const outputs: string[] = [];
    for (const scale of [0, 1, -1]) {
      const editor = createImageClient({ engineDirectory: testEngineDirectory, model: { ...prepared.model, loras: [{ path: 'adapter.safetensors', scale }] }, defaults: { size: { width: 256, height: 256 }, seed: 42, outputDirectory: directory, parameters: { steps: 2 } } });
      try {
        if (scale === 1) {
          const abort = new AbortController();
          await expect(editor.generate({ prompt: 'A bowl.' }, { signal: abort.signal, onEvent: event => { if (event.stage === 'generating') abort.abort(); } })).rejects.toMatchObject({ code: 'CANCELLED' });
        }
        const result = scale === -1
          ? await editor.edit({ instruction: 'Make the bowl green.', sourceImage: outputs[0]!, record: { includeInputs: true }, sidecar: true })
          : await editor.generate({ prompt: 'A blue ceramic bowl on a wooden table.', sidecar: true });
          if (result.status === 'refused') throw new Error(result.code);
        expect(result.loras).toEqual([{ filename: 'adapter.safetensors', scale, sha256: prepared.model.manifest.components.find(item => item.path === 'adapter.safetensors')!.sha256 }]);
        expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
        const sidecar = await readFile(result.sidecar!.path, 'utf8'); expect(sidecar).not.toContain(directory);
        expect(JSON.parse(sidecar).loras).toEqual(result.loras);
        outputs.push(result.image.path);
      } finally { await editor.dispose(); }
    }
    expect((await sharp(outputs[0]!).raw().toBuffer()).equals(await sharp(outputs[1]!).raw().toBuffer())).toBe(false);
    expect(await readFile(join(directory, 'adapter.safetensors'))).toEqual(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 600_000);
