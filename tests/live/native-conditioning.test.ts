import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createEditor, prepareModel } from '../../src/index.ts';
import { nativeRevision } from '../../src/backends/stable-diffusion-cpp/models.ts';
import { nativeAssets } from '../helpers/native-assets.ts';

it.each(['sdxl-photomaker-v1', 'sd15-ip-adapter', 'sdxl-ip-adapter-plus'])('maps %s private references, controls and asset provenance through the public API', async variant => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-v2-conditioning-'));
  const executable = join(directory, 'sd-cli');
  const identity = variant.includes('photomaker');
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
  const images: string[] = [];
  try {
    // Twelve photos expose lexicographic ordering bugs after 9.png.
    for (let i = 0; i < (identity ? 12 : 1); i++) {
      const path = join(directory, `reference-${i}.png`); images.push(path);
      await sharp({ create: { width: 16 + i, height: 16, channels: 3, background: 'blue' } }).png().toFile(path);
    }
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
if(args.includes('--help')) { console.log('stable-diffusion.cpp version fixture, commit ${nativeRevision}'); process.exit(0); }
const value = name => args[args.indexOf(name)+1]; const prompt = fs.readFileSync(value('--prompt-file'),'utf8');
if (value('--batched-cfg') !== 'off') process.exit(10);
if (args.includes('--init-img') || args.includes('--mask') || args.includes('--strength') || !args.includes('--disable-image-metadata')) process.exit(5);
if (${identity}) {
 if (value('--lora-apply-mode') !== 'at_runtime') process.exit(11);
 if (value('--photo-maker') !== 'photomaker-v1.safetensors' || !fs.existsSync(value('--photo-maker')) || value('--pm-style-strength') !== '15' || prompt !== 'A portrait of man img.') process.exit(6);
 const dir = value('--pm-id-images-dir'); const names = fs.readdirSync(dir).sort();
 if (names.length !== 12 || !dir.startsWith(process.cwd())) process.exit(7);
 for (let i=0;i<names.length;i++) if (fs.readFileSync(path.join(dir,names[i])).readUInt32BE(16) !== 16+i) process.exit(8);
} else {
 if (!args.includes('--clip_vision') || !args.includes('--ip-adapter') || value('--ip-adapter-strength') !== '0.7' || path.dirname(value('--ip-adapter-image')) !== process.cwd()) process.exit(9);
}
fs.writeFileSync(value('--output'),Buffer.from('${png.toString('base64')}','base64'));
`, { mode: 0o700 });
    const prepared = await prepareModel(variant, await nativeAssets(directory, variant));
    const editor = createEditor({ model: prepared.model, nativeExecutable: executable, defaults: { size: { width: 16, height: 16 }, outputDirectory: directory } });
    try {
      const request = { instruction: identity ? 'A portrait of {person}.' : 'Transfer the appearance.',
        references: identity ? [{ id: 'person', role: 'subject' as const, conditioning: 'identity' as const, className: 'man' as const, images: images as [string, ...string[]] }]
          : [{ id: 'style', role: 'style' as const, conditioning: 'appearance' as const, images: images as [string, ...string[]] }],
        parameters: identity ? { identityStyleStrength: 15 } : { appearanceStrength: 0.7 }, sidecar: {},
      };
      const result = await editor.edit({ ...request, references: request.references as [typeof request.references[number]] });
      expect(result.references[0]?.images).toEqual(images);
      expect(result.conditioning?.method).toBe(identity ? 'photomaker-v1' : variant.endsWith('-plus') ? 'ip-adapter-plus' : 'ip-adapter');
      expect(result.conditioning?.assets).toHaveLength(identity ? 1 : 2);
      for (const asset of result.conditioning!.assets) expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.effectiveParameters).not.toHaveProperty('strength');
      const sidecar = await readFile(result.sidecar!.path, 'utf8');
      expect(sidecar).not.toContain(directory);
      expect(JSON.parse(sidecar).conditioning).toEqual(result.conditioning);
      const controller = new AbortController();
      await expect(editor.edit({ ...request, references: request.references as [typeof request.references[number]] }, { signal: controller.signal, onProgress: event => { if (event.stage === 'editing') controller.abort(); } })).rejects.toMatchObject({ code: 'CANCELLED' });
      expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
    } finally { await editor.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
