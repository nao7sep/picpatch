import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { expect, it } from 'vitest';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
it('packages and starts the real renderer from outside the checkout without models or system Node', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The current desktop package qualification requires an Apple Silicon Mac.');
  // The same build rebuild performs: bundled tool, production bundle, then the .app only.
  for (const [command, args] of [[process.execPath, ['scripts/prepare-tools.mjs']], [join(root, 'node_modules/.bin/electron-vite'), ['build']], [join(root, 'node_modules/.bin/electron-builder'), ['--dir', '--mac', '--arm64']]] as const) await execute(command, [...args], { cwd: root, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const home = await mkdtemp(join(tmpdir(), 'picpatch-desktop-'));
  try {
    const executable = join(root, 'dist/mac-arm64/PicPatch.app/Contents/MacOS/PicPatch');
    const environment: NodeJS.ProcessEnv = { ...process.env, PICPATCH_DATA_DIR: home }; delete environment.ELECTRON_RUN_AS_NODE;
    const bundle = join(root, 'dist/mac-arm64/PicPatch.app/Contents');
    const info = JSON.parse((await execute('/usr/bin/plutil', ['-convert','json','-o','-',join(bundle,'Info.plist')])).stdout);
    const metadata = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    expect(info.CFBundleName).toBe(metadata.productName); expect(info.CFBundleShortVersionString).toBe(metadata.version);
    const icon = await readFile(join(bundle,'Resources',info.CFBundleIconFile));
    expect(icon.subarray(0,4).toString()).toBe('icns'); expect(icon.readUInt32BE(4)).toBe(icon.length);
    expect(icon.equals(await readFile(join(root, 'build/icon.icns')))).toBe(true);
    expect(info.CFBundleIconName).toBe('PicPatch');
    const catalog = await readFile(join(bundle, 'Resources/Assets.car'));
    expect(catalog.equals(await readFile(join(root, 'build/Assets.car')))).toBe(true);
    const renditions = JSON.parse((await execute('/usr/bin/assetutil', ['--info', join(bundle, 'Resources/Assets.car')])).stdout);
    expect(renditions).toEqual(expect.arrayContaining([expect.objectContaining({ AssetType: 'IconImageStack', Name: info.CFBundleIconName })]));
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(bundle, '..')]);
    await execute(executable, ['--smoke'], { cwd: tmpdir(), env: environment, timeout: 25_000 });
    const { readdir } = await import('node:fs/promises');
    const sessions = await readdir(join(home, 'sessions'));
    expect(sessions).toHaveLength(1);
    const session = JSON.parse(await readFile(join(home, 'sessions', sessions[0]!, 'session.json'), 'utf8'));
    expect(session.version).toBe(1); expect(session.runs).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('runs generation and saves its sidecar through the packaged application with existing model weights', async () => {
  const home = await mkdtemp(join(tmpdir(), 'picpatch-inference-'));
  try {
    const executable = join(root, 'dist/mac-arm64/PicPatch.app/Contents/MacOS/PicPatch');
    const environment: NodeJS.ProcessEnv = { ...process.env, PICPATCH_DATA_DIR: home, PATH: '/usr/bin:/bin' }; delete environment.ELECTRON_RUN_AS_NODE;
    await execute(executable, ['--smoke-inference', join(root, 'sdk/node_modules/.cache/picpatch-live/native-inference-config.json')], { cwd: tmpdir(), env: environment, timeout: 310_000, maxBuffer: 1024 * 1024 });
    const { readdir } = await import('node:fs/promises');
    const sessions = await readdir(join(home, 'sessions'));
    const completed = (await Promise.all(sessions.map(async id => JSON.parse(await readFile(join(home, 'sessions', id, 'session.json'), 'utf8'))))).find(session => session.runs.length);
    expect(completed.runs[0].status).toBe('completed');
    const image = join(home, 'sessions', completed.id, completed.runs[0].output);
    expect(await sharp(image).metadata()).toMatchObject({ format: 'png', width: 512, height: 512 });
    expect(JSON.parse(await readFile(image.slice(0, -4) + '-picpatchsdk.json', 'utf8'))).toHaveProperty('seed', 42);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 330_000);

it('localizes the real packaged renderer and checks constrained dialog layout in every language', async () => {
  const home = await mkdtemp(join(tmpdir(), 'picpatch-languages-'));
  try {
    const executable = join(root, 'dist/mac-arm64/PicPatch.app/Contents/MacOS/PicPatch');
    const environment: NodeJS.ProcessEnv = { ...process.env, PICPATCH_DATA_DIR: home }; delete environment.ELECTRON_RUN_AS_NODE;
    const nativeLanguage = async () => { try { return (await execute('/usr/bin/defaults', ['read', 'io.github.nao7sep.picpatch', 'AppleLanguages'])).stdout; } catch { return undefined; } };
    const before = await nativeLanguage();
    const info = join(root, 'dist/mac-arm64/PicPatch.app/Contents/Info.plist');
    const tags = JSON.parse((await execute('/usr/bin/plutil', ['-extract', 'CFBundleLocalizations', 'json', '-o', '-', info])).stdout);
    expect(tags.sort()).toEqual(['en','de','es','fr','it','pt-BR','ru','ja','ko','zh-Hans'].sort());
    await execute(executable, ['--smoke-localization'], { cwd: tmpdir(), env: environment, timeout: 255_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).language).toBe('ko');
    expect(await nativeLanguage()).toBe(before);
  } finally { await rm(home, { recursive: true, force: true }); }
});
