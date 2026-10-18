import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, prepareModel } from 'picpatchsdk';
import assets from '../fixtures/native-sdxl-assets.json' with { type: 'json' };

interface Configuration { directory: string; executable: string; checkpoint: string; photoMaker: string; ipAdapter: string; ipAdapterPlus: string; clipVision: string }
async function configuration(): Promise<Configuration> {
  const path = process.env.PICPATCH_NATIVE_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../../../node_modules/.cache/picpatch-live/native-inference-config.json', import.meta.url));
  try { return JSON.parse(await readFile(path, 'utf8')) as Configuration; }
  catch (cause) { throw new Error('Prepare the documented native SDXL test assets and PICPATCH_NATIVE_INFERENCE_CONFIG. This test never downloads weights or builds the runtime.', { cause }); }
}

it('runs native SDXL generation, repeated variation and each dedicated conditioning workflow with real weights', async () => {
  const config = await configuration();
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-native-inference-'));
  let phase = 'base preparation';
  try {
    const base = await prepareModel('sdxl', { directory: config.directory, checkpoint: config.checkpoint });
    expect(base.model.manifest.components[0]!.sha256).toBe(assets.find(asset => asset.role === 'checkpoint')!.sha256);
    const options = { nativeExecutable: config.executable, defaults: { outputDirectory: directory, size: { width: 256, height: 256 }, seed: 42 } };
    const editor = createEditor({ ...options, model: base.model });
    let original: string;
    try {
      phase = 'base generation';
      const generated = await editor.generate({ prompt: 'A studio photograph of an adult man with short brown hair wearing a blue shirt, neutral background.', parameters: { steps: 4 }, sidecar: {} });
      original = generated.image.path;
      expect(await sharp(original).metadata()).toMatchObject({ width: 256, height: 256, format: 'png' });
      expect((await sharp(original).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      expect((await sharp(original).metadata()).comments ?? []).toEqual([]);
      let source = join(directory, 'non-square.png');
      await sharp(original).resize(320, 192).png().toFile(source);
      for (const strength of [0, 0.5, 1]) {
        phase = `variation strength ${strength}`;
        const result = await editor.edit({ instruction: 'A watercolor portrait with blue tones.', sourceImage: source, parameters: { steps: 4, strength } });
        expect(result.effectiveParameters.strength).toBe(strength);
        expect(await sharp(result.image.path).metadata()).toMatchObject({ width: 256, height: 256 });
        source = result.image.path;
      }
      phase = 'native loading cancellation';
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(editor.generate({ prompt: 'A blue ceramic bowl.', parameters: { steps: 10000 } }, { signal: controller.signal, onProgress: event => {
          if (event.stage === 'generating') timer = setTimeout(() => controller.abort(), 1500);
        } })).rejects.toMatchObject({ code: 'CANCELLED' });
      } finally { clearTimeout(timer); }
    } finally { await editor.dispose(); }
    const second = join(directory, 'second.png');
    await sharp(original!).flop().png().toFile(second);
    const originalBytes = await readFile(original!);
    for (const variant of ['sdxl-photomaker-v1', 'sdxl-ip-adapter', 'sdxl-ip-adapter-plus']) {
      phase = variant;
      const identity = variant.includes('photomaker');
      const prepared = await prepareModel(variant, { directory: config.directory, checkpoint: config.checkpoint,
        ...(identity ? { photoMaker: config.photoMaker } : { ipAdapter: variant.endsWith('-plus') ? config.ipAdapterPlus : config.ipAdapter, clipVision: config.clipVision }) });
      for (const component of prepared.model.manifest.components) {
        const role = Object.entries(config).find(([, path]) => path === component.path)?.[0];
        expect(component.sha256).toBe(assets.find(asset => asset.role === role)!.sha256);
      }
      const conditioned = createEditor({ ...options, model: prepared.model });
      try {
        const result = await conditioned.edit({ instruction: identity ? 'A studio portrait of {person} wearing a green shirt.' : 'A watercolor portrait with green tones.',
          references: identity ? [{ id: 'person', role: 'subject', conditioning: 'identity', className: 'man', images: [original!, second] }]
            : [{ id: 'appearance', role: 'style', conditioning: 'appearance', images: [original!] }],
          parameters: { steps: 4 }, sidecar: {},
        });
        expect(await sharp(result.image.path).metadata()).toMatchObject({ width: 256, height: 256 });
        expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
        expect(result.conditioning?.method).toBe(identity ? 'photomaker-v1' : variant.endsWith('-plus') ? 'ip-adapter-plus' : 'ip-adapter');
        const record = await readFile(result.sidecar!.path, 'utf8');
        expect(record).not.toContain(directory); expect(record).not.toContain(config.directory);
        expect(await readFile(original!)).toEqual(originalBytes);
      } finally { await conditioned.dispose(); }
    }
    expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
  } catch (cause) { throw new Error(`Native inference failed during ${phase}.`, { cause }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}, 3_600_000);
