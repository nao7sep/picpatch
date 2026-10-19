import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
const { launcherLifecycle, launcherPids } = await import(new URL('../../scripts/launcher-lifecycle.mjs', import.meta.url).href);

it.each([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const)('settles its child and stops watchers before exiting on %s', async (signal, code) => {
  const signals = new EventEmitter(); const exit = vi.fn(); const closeWatcher = vi.fn();
  const owner = launcherLifecycle({ signals, exit });
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  owner.track(child); owner.cleanup.add(closeWatcher);
  signals.emit(signal);
  expect(owner.stopping).toBe(true); expect(closeWatcher).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(exit).not.toHaveBeenCalled();
  signals.emit(signal); expect(child.kill).toHaveBeenCalledOnce();
  child.emit('close', 0); await owner.stop(signal);
  expect(exit).toHaveBeenCalledExactlyOnceWith(code);
});
it('does not signal already settled children', async () => {
  const exit = vi.fn(); const owner = launcherLifecycle({ signals: new EventEmitter(), exit });
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  owner.track(child); child.emit('close', 0); await Promise.resolve();
  await owner.stop('SIGTERM'); expect(child.kill).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(143);
});
it('identifies only other development supervisors from this checkout', () => {
  const launcher = '/work/Pic Patch/scripts/launch.mjs';
  expect(launcherPids(`1 node ${launcher} dev\n2 /usr/bin/node ${launcher} dev\n3 node /other/scripts/launch.mjs dev\n4 /bin/zsh -c node ${launcher} dev\n5 node ${launcher} built`, launcher, 1)).toEqual([2]);
});
it('keeps redirected Windows failures noninteractive and treats intentional stops consistently', async () => {
  for (const name of ['run-dev', 'run-built', 'rebuild']) {
    const powershell = await readFile(`scripts/${name}.ps1`, 'utf8');
    expect(powershell).toContain('IsInputRedirected'); expect(powershell).toContain('UserInteractive');
    expect(powershell).toContain('@(129, 130, 143)');
    const shell = await readFile(`scripts/${name}.command`, 'utf8');
    expect(shell).toContain('result != 129 && result != 130 && result != 143');
    expect(shell).toContain('[[ -t 0 ]]');
  }
});
it('closes the old app before building and starts watched replacements in the background', async () => {
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const runtime = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const entry = join(root, 'out/main.mjs');
  const order: string[] = []; let current: EventEmitter | undefined;
  let change: (() => void) | undefined;
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const oldArgs = process.argv; const saved = Object.fromEntries(['SIGINT','SIGTERM','SIGHUP'].map(s => [s, process.listeners(s)]));
  const execute = Object.assign(vi.fn(), { [promisify.custom]: async () => ({ stdout: current ? `123 ${runtime} ${entry}\n` : '' }) });
  vi.doMock('node:child_process', () => ({ execFile: execute, spawn: (_exe: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { current = undefined; child.emit('close', 0); }) });
    if (args.includes('--dev')) {
      expect(current).toBeUndefined(); order.push('build');
      queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); });
    } else { current = child; order.push(args.includes('--background-reload') ? 'background' : 'foreground'); }
    return child;
  } }));
  vi.doMock('node:fs', () => ({ watch: (_path: string, _options: unknown, callback: () => void) => { change = callback; return { close: vi.fn() }; } }));
  vi.doMock('node:fs/promises', () => ({ stat: async () => ({ mtime: new Date() }) }));
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { order.push('close'); current?.emit('close', 0); current = undefined; return true; });
  vi.useFakeTimers();
  try {
    process.argv = ['node', join(root,'scripts/launch.mjs'), 'dev'];
    await import(new URL('../../scripts/launch.mjs', import.meta.url).href);
    expect(order).toEqual(['build','foreground']);
    change!(); await vi.advanceTimersByTimeAsync(300);
    expect(order).toEqual(['build','foreground','close','build','background']);
  } finally {
    process.argv = oldArgs; platform.mockRestore(); kill.mockRestore(); vi.useRealTimers();
    for (const signal of ['SIGINT','SIGTERM','SIGHUP']) for (const handler of process.listeners(signal)) if (!saved[signal]!.includes(handler)) process.removeListener(signal, handler);
    vi.doUnmock('node:child_process'); vi.doUnmock('node:fs'); vi.doUnmock('node:fs/promises'); vi.resetModules();
  }
});
