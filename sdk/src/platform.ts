// The few operating-system differences the SDK must handle: the minimal environment tools
// start with, process ownership and termination, and how files and directories reach the disk.
import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { copyFile, link, open, symlink } from './storage.ts';

import { currentHost, type Host } from './hosts.ts';
export { currentHost, hostId, runtimeHosts, supportsRuntime } from './hosts.ts';
export type { Host, HostId, RuntimeName } from './hosts.ts';

/** Windows' own folders, the only environment values the SDK reads (a Windows process cannot start without SystemRoot). */
const windowsFolders = () => { const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'; return { root, temp: process.env.TEMP ?? process.env.TMP ?? win32.join(root, 'Temp') }; };
/** The environment a tool or worker starts from: no caller environment, only what the OS needs to start a process. */
export function toolEnvironment(host: Host = currentHost(), extraPath: string[] = []): NodeJS.ProcessEnv {
  if (host.platform !== 'win32') return { PATH: [...extraPath, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), LANG: 'en_US.UTF-8' };
  const { root: systemRoot, temp } = windowsFolders();
  return { SystemRoot: systemRoot, windir: systemRoot, TEMP: temp, TMP: temp, PATH: [...extraPath, win32.join(systemRoot, 'System32'), systemRoot, win32.join(systemRoot, 'System32', 'Wbem')].join(win32.delimiter) };
}
/** Windows' own tar (bsdtar) reads zip archives. */
export const archiveTool = (host: Host = currentHost()): string => host.platform === 'win32' ? win32.join(windowsFolders().root, 'System32', 'tar.exe') : '/usr/bin/tar';
/** A virtual environment's interpreter. */
export const venvPython = (venv: string, host: Host = currentHost()): string => host.platform === 'win32' ? win32.join(venv, 'Scripts', 'python.exe') : posix.join(venv, 'bin', 'python');

/** POSIX children lead their own process group so the whole group can be signalled; Windows children get no console window. */
export const ownedSpawn = { detached: process.platform !== 'win32', windowsHide: true } as const;
/**
 * Signals an owned child and everything it started. POSIX signals the process group; Windows has no
 * groups or graceful signals for console tools, so the whole tree is ended with taskkill. Throws
 * only when the request itself could not be made; a process already gone is not an error.
 */
export function signalOwned(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') { process.kill(-pid, signal); return; }
  const killer = spawn(win32.join(windowsFolders().root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  killer.once('error', () => {});
}

/** Flushes a file. Windows flushes only through a writable handle. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Flushes a directory entry. Windows cannot open a directory for flushing; its rename is already durable on NTFS. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
/**
 * A second name for a large file without copying it where possible: a symbolic link; on Windows, where
 * that needs administrator rights or Developer Mode, a hard link, and a copy only across volumes.
 */
export async function aliasFile(source: string, alias: string): Promise<void> {
  try { await symlink(source, alias); return; }
  catch (cause) { if (process.platform !== 'win32' || (cause as NodeJS.ErrnoException).code !== 'EPERM') throw cause; }
  try { await link(source, alias); }
  catch (cause) { if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause; await copyFile(source, alias); }
}
