// Maintenance only: node scripts/prepare-icon.mjs build|verify <liquid-glass-icon tool> <gptimg SDK>
// Ordinary packaging uses the committed catalog and needs neither tool nor Xcode.
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [action, glassTool, imageSdk] = process.argv.slice(2);
if (!['build', 'verify'].includes(action) || !glassTool || !imageSdk) throw new Error('Usage: prepare-icon.mjs build|verify <liquid-glass-icon tool directory> <gptimg SDK directory>');
const load = (base, file) => import(pathToFileURL(resolve(base, file)).href);
const { GptImg, completed } = await load(imageSdk, 'src/index.ts');
const { buildManifest } = await load(glassTool, 'lib/manifest.mjs');
const { writeBundle } = await load(glassTool, 'lib/bundle.mjs');
const { deriveScaleOffset } = await load(glassTool, 'lib/measure.mjs');
const { diffBundles } = await load(glassTool, 'lib/run.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'picpatch-icon-'));
try {
  const source = await readFile(join(root, 'assets/picpatch.svg'), 'utf8');
  const plate = '<rect x="64" y="64" width="896" height="896" rx="200" fill="url(#back)"/>';
  if (source.split(plate).length !== 2) throw new Error('Classic artwork changed: review the foreground/background split.');
  const foreground = source.replace(plate, '');
  const definitions = source.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
  if (!definitions) throw new Error('Missing artwork gradients.');
  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${definitions}<rect width="1024" height="1024" fill="url(#back)"/></svg>`;
  const img = new GptImg();
  for (const [name, svg] of [['foreground', foreground], ['background', background]]) {
    const input = join(temp, `${name}.svg`);
    await writeFile(input, svg);
    const result = completed(await img.encode({ in: input, outDir: temp, outName: `${name}-rendered`, format: 'png' }));
    await cp(result.output, join(temp, `${name}.png`));
  }
  const content = join(temp, 'foreground.png');
  // The existing SVG already has its margins: retain the full 1024 frame (sMac=1),
  // with no optical nudge. The shared derivation accounts for Tahoe's safe zone.
  const { scale, offset } = deriveScaleOffset({ content, sMac: 1, nudge: [0, 0] });
  const manifest = buildManifest({ layers: [
    { image: 'foreground.png', scale, offset },
    { image: 'background.png' },
  ] });
  const bundle = writeBundle({ outDir: temp, name: 'PicPatch', images: [content, join(temp, 'background.png')], manifest });
  const destination = join(root, 'assets/PicPatch.icon');
  if (action === 'verify') {
    const difference = diffBundles(bundle, destination);
    if (difference) throw new Error(`Stale layered icon: ${difference}`);
    console.log('Layered icon matches the classic artwork and recorded placement.');
  } else {
    const { compileIcon } = await load(glassTool, 'lib/compile.mjs');
    const { assetsCar } = compileIcon({ bundle, outDir: temp, appIcon: 'PicPatch' });
    await rm(destination, { recursive: true, force: true });
    await cp(bundle, destination, { recursive: true });
    await cp(assetsCar, join(root, 'assets/Assets.car'));
  }
} finally { await rm(temp, { recursive: true, force: true }); }
