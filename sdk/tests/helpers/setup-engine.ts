import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { installEngine } from 'picpatchsdk';
import { testEngineDirectory } from './engine.ts';

/** Full-gate prerequisite, independent of test order. Never acquires model weights. */
export default async function setupEngine() {
  // The managed Python engine is Apple-only; Windows runs the native lane alone.
  if (process.platform === 'win32') return;
  const toolDirectories = (process.env.PATH ?? '').split(delimiter).filter(path => path.startsWith('/'));
  let uvExecutable = process.env.PICPATCH_UV_EXECUTABLE;
  if (!uvExecutable) for (const directory of toolDirectories) {
    const candidate = join(directory, 'uv');
    try { await access(candidate, constants.X_OK); uvExecutable = candidate; break; } catch { /* Try the next caller-selected tool directory. */ }
  }
  if (!uvExecutable) throw new Error('The full gate requires uv or PICPATCH_UV_EXECUTABLE.');
  const cacheDirectory = (await promisify(execFile)(uvExecutable, ['cache', 'dir'])).stdout.trim();
  const installed = await installEngine({ uvExecutable, engineDirectory: testEngineDirectory, toolDirectories, cacheDirectory, offline: true });
  if (installed.status !== 'ready') throw new Error(installed.code);
}
