import { copyRuntimeResources } from './runtime-resources.mjs';
import sharp from 'sharp';
import { packager } from '@electron/packager';
import { transform } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = join(root, 'dist', 'package');
await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
await mkdir(join(staging,'dist'),{recursive:true});
for (const file of (await readdir(join(root, 'dist'))).filter(name => /\.(?:mjs|cjs|js|html|css|png)$/.test(name))) await cp(join(root,'dist',file),join(staging,'dist',file));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Desktop dependency delivery is currently qualified for Apple Silicon macOS only.');
const uvCache = join(root, 'node_modules/.cache/picpatch-desktop/uv-0.13.1');
await mkdir(join(staging, 'dist/tools'), { recursive: true });
try { await cp(join(uvCache, 'uv-aarch64-apple-darwin/uv'), join(staging, 'dist/tools/uv')); }
catch (error) { throw new Error('Prepare the bundled setup tool with npm run prepare:tools before packaging.', { cause: error }); }
await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
await writeFile(join(staging, 'THIRD_PARTY_NOTICES'), 'uv 0.13.1 — https://github.com/astral-sh/uv/tree/0.13.1\n\n' + await readFile(join(uvCache, 'LICENSE-MIT'), 'utf8') + '\n' + await readFile(join(uvCache, 'LICENSE-APACHE'), 'utf8'));
const sdk = JSON.parse(await readFile(join(root,'sdk','package.json'),'utf8'));
// The app's distribution compiles its bundled source dependency; the standalone SDK remains source-only.
async function compile(directory, target) {
  await mkdir(target,{ recursive:true });
  for (const entry of await readdir(directory,{ withFileTypes:true })) {
    const source=join(directory,entry.name), destination=join(target,entry.name);
    if(entry.isDirectory()) await compile(source,destination);
    else if(entry.name.endsWith('.ts')) { const result=await transform(await readFile(source,'utf8'),{loader:'ts',format:'esm',target:'node24'}); await writeFile(destination.replace(/\.ts$/,'.js'),result.code.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts\1/g,'$1$2.js$1')); }
    else await cp(source,destination);
  }
}
await compile(join(root,'sdk','src'),join(staging,'sdk','src'));
for (const name of ['protocol','LICENSE','THIRD_PARTY_NOTICES']) await cp(join(root,'sdk',name),join(staging,'sdk',name),{recursive:true});
await copyRuntimeResources(join(root, 'sdk/runtimes'), join(staging, 'sdk/runtimes'));
await writeFile(join(staging,'sdk','package.json'),JSON.stringify({name:sdk.name,version:sdk.version,private:true,type:'module',main:'./src/index.js',exports:{'.':'./src/index.js','./types':'./src/browser-types.js'},dependencies:sdk.dependencies}));
const app=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
await writeFile(join(staging,'package.json'),JSON.stringify({name:app.name,productName:app.productName,version:app.version,private:true,type:'module',main:'dist/main.mjs',dependencies:{picpatchsdk:'file:./sdk'}}));
await execute('npm',['install','--offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:staging,maxBuffer:1024*1024});
const version=JSON.parse(await readFile(join(root,'node_modules','electron','package.json'),'utf8')).version;
let electronZipDir;
let icon = join(root, 'dist', 'icon.png');
if (process.platform === 'darwin') {
  const iconset = join(root, 'dist', 'PicPatch.iconset'); await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) await sharp(join(root, 'assets', 'picpatch.svg')).resize(size * scale).png().toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
  }
  icon = join(root, 'dist', 'PicPatch.icns');
  await execute('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
  electronZipDir = join(root, 'node_modules', '.cache', 'picpatch-desktop'); await mkdir(electronZipDir, { recursive: true });
  const zip = join(electronZipDir, `electron-v${version}-darwin-${process.arch}.zip`);
  await execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(root, 'node_modules', 'electron', 'dist', 'Electron.app'), zip]);
}
const paths = await packager({ dir: staging, out: join(root, 'dist'), name: 'PicPatch', appBundleId: 'picpatch.desktop', extendInfo: { CFBundleIconName: 'PicPatch', CFBundleLocalizations: ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'ja', 'ko', 'zh-Hans'] }, platform: process.platform, arch: process.arch, electronVersion: version, ...(electronZipDir ? { electronZipDir } : {}), ...(process.platform === 'darwin' ? { icon } : {}), overwrite: true, asar: false, prune: true });
if (process.platform === 'darwin') {
  // Reuse the compiled Tahoe catalog; retain our classic ICNS rather than actool's fallback.
  await cp(join(root, 'assets/Assets.car'), join(paths[0], 'PicPatch.app/Contents/Resources/Assets.car'));
  await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', join(paths[0], 'PicPatch.app')]);
}
console.log(paths[0]);
