import { testPython } from '../helpers/python.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { access, readFile, mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectRuntime, setupRuntime, createEditor } from '../../src/index.ts';
import { runInstaller } from '../../src/runtime/command.ts';
const execute = promisify(execFile);
const python = testPython;
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-runtime-live-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function uvPath(): Promise<string> {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry, 'uv');
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next explicit PATH entry. */ }
  }
  throw new Error('Full runtime tests require uv on PATH.');
}
it('inspects the real environment and reports truthful model-free readiness', async () => {
  expect(await inspectRuntime(python)).toMatchObject({ status: 'worker-ready', models: [] });
});
it('creates a fresh locked environment offline and inspects it through the public API', async () => {
  const uvExecutable = await uvPath();
  const cacheDirectory = (await execute(uvExecutable, ['cache', 'dir'])).stdout.trim();
  const destination = join(directory, 'runtime');
  const result = await setupRuntime({ directory: destination, pythonExecutable: python, uvExecutable, cacheDirectory, offline: true });
  expect(result).toMatchObject({ status: 'worker-ready', models: [], dependencyLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect((await stat(result.pythonExecutable)).isFile()).toBe(true);
  expect((await inspectRuntime(result.pythonExecutable)).status).toBe('worker-ready');
  const editor = createEditor({ pythonExecutable: result.pythonExecutable }); await editor.dispose();
  await expect(setupRuntime({ directory: destination, pythonExecutable: python, uvExecutable, offline: true })).rejects.toMatchObject({ code: 'OUTPUT_CONFLICT' });
});
it('cleans a failed setup only after the installer closes', async () => {
  await expect(setupRuntime({ directory: join(directory, 'runtime'), pythonExecutable: python, uvExecutable: '/missing/picpatch-uv', offline: true })).rejects.toMatchObject({ code: 'RUNTIME_SETUP' });
  expect(await readdir(directory)).toEqual([]);
});
async function readyPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await delay(10);
  }
  throw new Error('Installer fixture did not become ready.');
}
it('waits for a cancelled installer that ignores SIGTERM and confirms process closure', async () => {
  const script = join(directory, 'installer.mjs'); const pidFile = join(directory, 'pid');
  await writeFile(script, "import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = runInstaller(process.execPath, [script, pidFile], directory, process.env, 10_000, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  try {
    const pid = await readyPid(pidFile); controller.abort(); await cancelled;
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally { controller.abort(); await pending.catch(() => {}); }
});
it('reports an installer deadline and confirms process closure', async () => {
  const script = join(directory, 'waiting.mjs'); const pidFile = join(directory, 'pid');
  await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
  await expect(runInstaller(process.execPath, [script, pidFile], directory, process.env, 1_000)).rejects.toMatchObject({ code: 'TIMEOUT' });
  const pid = Number(await readFile(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});
it('fails offline setup with an empty cache and removes only the failed environment', async () => {
  const uvExecutable = await uvPath(); const destination = join(directory, 'runtime');
  await expect(setupRuntime({ directory: destination, pythonExecutable: python, uvExecutable, offline: true })).rejects.toMatchObject({ code: 'RUNTIME_SETUP' });
  expect(await readdir(directory)).toEqual([]);
});
it('allows only one setup owner for the same destination', async () => {
  const uvExecutable = await uvPath(); const cacheDirectory = (await execute(uvExecutable, ['cache', 'dir'])).stdout.trim();
  const request = { directory: join(directory, 'runtime'), pythonExecutable: python, uvExecutable, cacheDirectory, offline: true };
  const results = await Promise.allSettled([setupRuntime(request), setupRuntime(request)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const failed = results.find(result => result.status === 'rejected');
  expect(failed).toMatchObject({ reason: { code: 'OUTPUT_CONFLICT' } });
});
it('cleans a new environment when cancelled after installation, before returning readiness', async () => {
  const uvExecutable = await uvPath(); const cacheDirectory = (await execute(uvExecutable, ['cache', 'dir'])).stdout.trim();
  const controller = new AbortController();
  await expect(setupRuntime({ directory: join(directory, 'runtime'), pythonExecutable: python, uvExecutable, cacheDirectory, offline: true }, {
    signal: controller.signal, onProgress: event => { if (event.stage === 'checking') controller.abort(); },
  })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await readdir(directory)).toEqual([]);
});
