import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
it('packages and starts the real renderer from outside the checkout without models or system Node', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The current desktop package qualification requires an Apple Silicon Mac.');
  await execute(process.execPath, ['scripts/package.mjs'], { cwd: root, timeout: 150_000, maxBuffer: 1024 * 1024 });
  const home = await mkdtemp(join(tmpdir(), 'picpatch-desktop-'));
  try {
    const executable = join(root, 'dist/PicPatch-darwin-arm64/PicPatch.app/Contents/MacOS/PicPatch');
    const environment: NodeJS.ProcessEnv = { ...process.env, PICPATCH_DATA_DIR: home }; delete environment.ELECTRON_RUN_AS_NODE;
    await execute(executable, ['--smoke'], { cwd: tmpdir(), env: environment, timeout: 25_000 });
    const { readdir } = await import('node:fs/promises');
    const sessions = await readdir(join(home, 'sessions'));
    expect(sessions).toHaveLength(1);
    const session = JSON.parse(await readFile(join(home, 'sessions', sessions[0]!, 'session.json'), 'utf8'));
    expect(session.version).toBe(1); expect(session.runs).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
