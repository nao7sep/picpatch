import { launcherLifecycle, launcherPids } from './launcher-lifecycle.mjs';
import { spawn, execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2];
if (!['dev', 'built', 'rebuild'].includes(mode)) throw new Error('Choose dev, built or rebuild.');
const windows = process.platform === 'win32';
const runtime = join(root, 'node_modules', 'electron', 'dist', windows ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron');
const application = join(root, 'dist', `PicPatch-${process.platform}-${process.arch}`, windows ? 'PicPatch.exe' : 'PicPatch.app/Contents/MacOS/PicPatch');
const entry = join(root, 'out', 'main.mjs');
const lifecycle = launcherLifecycle();
async function run(executable, args) {
  await new Promise((resolve, reject) => { if (lifecycle.stopping) return resolve(); const child = lifecycle.track(spawn(executable, args, { cwd: root, stdio: 'inherit', shell: windows && executable === 'npm.cmd' })); child.on('error', reject); child.on('exit', code => code === 0 || lifecycle.stopping ? resolve() : reject(new Error(`${executable} failed (${code}).`))); });
}
async function ownedInstances() {
  if (windows) {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress']);
    const parsed = JSON.parse(stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(p => p.ExecutablePath?.toLowerCase() === application.toLowerCase() || p.ExecutablePath?.toLowerCase() === runtime.toLowerCase() && p.CommandLine?.includes(entry)).map(p => p.ProcessId);
  }
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,command=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/); if (!match) return [];
    const command = match[2];
    return command === application || command.startsWith(application + ' ') || command.startsWith(runtime + ' ') && command.includes(entry) ? [Number(match[1])] : [];
  });
}
async function replace() {
  const pids = await ownedInstances();
  for (const pid of pids) {
    if (windows) await execute('taskkill.exe', ['/PID', String(pid)]);
    else { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  const deadline = Date.now() + 60_000;
  while ((await ownedInstances()).some(pid => pids.includes(pid))) {
    if (Date.now() >= deadline) throw new Error('The existing PicPatch did not close. Resolve its save or cancellation question, then retry. It was not forced to quit.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
// A prior watcher must stop too, or it can resurrect development mode after run-built.
async function stopWatchers() {
  const launcher = join(root, 'scripts', 'launch.mjs');
  let pids;
  if (windows) {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress']);
    const parsed = JSON.parse(stdout || '[]');
    pids = (Array.isArray(parsed) ? parsed : [parsed]).filter(p => p.ProcessId !== process.pid && p.Name?.toLowerCase() === 'node.exe' && (p.CommandLine?.endsWith(`${launcher} dev`) || p.CommandLine?.endsWith(`"${launcher}" dev`))).map(p => p.ProcessId);
  } else {
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,command=']);
    pids = launcherPids(stdout, launcher, process.pid);
  }
  for (const pid of pids) {
    if (windows) await execute('taskkill.exe', ['/PID', String(pid), '/T']);
    else { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  const deadline = Date.now() + 60_000;
  for (const pid of pids) {
    for (;;) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (Date.now() >= deadline) throw new Error('The previous development launcher did not stop. No new app was started.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
async function main() {
  await stopWatchers();
  if (lifecycle.stopping) return;
  const npm = windows ? 'npm.cmd' : 'npm';
  if (mode === 'rebuild') {
    await replace();
    console.log('Install development dependencies'); await run(npm, ['install', '--no-audit', '--no-fund']);
    console.log('Check and package PicPatch'); await run(npm, ['run', 'typecheck']); await run(npm, ['run', 'package']);
  }
  if (mode !== 'dev') {
    let built; try { built = await stat(application); } catch { throw new Error('No packaged PicPatch exists. Run scripts/rebuild first.'); }
    console.log(`Launch PicPatch built at ${built.mtime.toISOString()}`); await replace();
    if (lifecycle.stopping) return;
    const child = spawn(application, [], { cwd: root, detached: true, stdio: 'ignore' }); child.on('error', error => { console.error(error); process.exitCode = 1; }); child.unref();
  } else {
    await stat(runtime).catch(() => { throw new Error('Install dependencies and the Electron runtime before running development mode.'); });
    let rebuilding = false, dirty = false, timer; let launched = false;
    lifecycle.cleanup.add(() => clearTimeout(timer));
    async function rebuild() {
      if (lifecycle.stopping) return; dirty = true; if (rebuilding) return; rebuilding = true;
      try {
        while (dirty && !lifecycle.stopping) {
          dirty = false;
          // Close before build removes split chunks still needed by the running app.
          await replace();
          if (lifecycle.stopping) return;
          console.log('Build development sources'); await run(process.execPath, [join(root, 'scripts', 'build.mjs'), '--dev']);
          if (lifecycle.stopping) return;
          const child = lifecycle.track(spawn(runtime, [entry, ...(launched ? ['--background-reload'] : [])], { cwd: root, stdio: 'inherit' })); child.on('error', error => console.error(error));
          launched = true;
        }
      } catch (error) { if (!lifecycle.stopping) console.error(error); }
      finally { rebuilding = false; }
    }
    await rebuild();
    if (!lifecycle.stopping) for (const directory of ['src', 'sdk/src', 'assets']) {
      const watcher = watch(join(root, directory), { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(() => { void rebuild(); }, 300); });
      lifecycle.cleanup.add(() => watcher.close());
    }
  }

}
await main();
