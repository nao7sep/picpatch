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
export const spawnOwnership = (platform: NodeJS.Platform = process.platform) => ({ detached: platform !== 'win32', windowsHide: true }) as const;
export const ownedSpawn = spawnOwnership();
/**
 * How an owned child and everything it started is ended. POSIX signals the process group; Windows has no
 * groups or graceful signals for console tools, so the whole tree is ended with taskkill.
 */
export function ownedTermination(pid: number, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): { group: number; signal: NodeJS.Signals } | { command: string; args: string[] } {
  if (platform !== 'win32') return { group: -pid, signal };
  return { command: win32.join(windowsFolders().root, 'System32', 'taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] };
}
/** Throws only when the request itself could not be made; a process already gone is not an error. */
/** Keeps the last bytes a child process wrote to a stream, so a process that fails can say why. */
export function streamTail(stream: NodeJS.ReadableStream, limit = 8192): () => string | undefined {
  let tail = Buffer.alloc(0);
  stream.on('data', (chunk: Buffer) => { tail = Buffer.concat([tail, chunk]); if (tail.length > limit) tail = tail.subarray(tail.length - limit); });
  return () => tail.length ? tail.toString('utf8') : undefined;
}
export function signalOwned(pid: number, signal: NodeJS.Signals): void {
  const termination = ownedTermination(pid, signal);
  if ('group' in termination) { process.kill(termination.group, termination.signal); return; }
  const killer = spawn(termination.command, termination.args, { stdio: 'ignore', windowsHide: true });
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
