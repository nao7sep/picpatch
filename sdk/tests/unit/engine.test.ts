import { withDeadline } from '../../src/operations.ts';
import { PicPatchSdkError } from '../../src/errors.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageClient, inspectEngine, installEngine, type EngineRecord } from '../../src/index.ts';
import { engineDefinition, identifyEngine, validRecord } from '../../src/runtime/engine/identity.ts';
import { runCommand } from '../../src/runtime/engine/command.ts';

let directory: string;
let tool: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-engine-'));
  tool = join(directory, 'uv');
  const fixture = await readFile(fileURLToPath(new URL('../fixtures/engine-tool.mjs', import.meta.url)), 'utf8');
  await writeFile(tool, `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const options = () => ({ uvExecutable: tool, engineDirectory: join(directory, 'engine') });

it('inspects absence without creating anything and rejects relative settings before work', async () => {
  expect(await inspectEngine({ engineDirectory: options().engineDirectory })).toMatchObject({ status: 'missing', code: 'ENGINE_MISSING' });
  expect(await readdir(directory)).toEqual(['uv']);
  for (const input of [{ uvExecutable: 'uv' }, { cacheDirectory: 'relative' }, { pythonDirectory: '' }, { toolDirectories: ['bin'] }, { offline: 'yes' }, { engineDirectory: '.' }]) {
    await expect(installEngine({ ...options(), ...input } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  }
});
it('publishes a versioned reference only after checks, reuses it and isolates child configuration', async () => {
  vi.stubEnv('UV_INDEX_URL', 'private-sentinel'); vi.stubEnv('HF_TOKEN', 'private-sentinel');
  const stages: string[] = [];
  const result = await installEngine(options(), { onEvent: event => stages.push(event.stage) });
  expect(result.origin).toBe('installed');
  // The earlier calls had no listener, so this first listening call still receives the startup record.
  expect(stages).toEqual(['startup', 'started', 'checking', 'installing', 'checking', 'publishing', 'succeeded']);
  expect(await inspectEngine({ engineDirectory: result.engineDirectory })).toMatchObject({ status: 'ready', pythonExecutable: result.pythonExecutable });
  const installation = dirname(dirname(dirname(result.pythonExecutable)));
  const observed = JSON.parse(await readFile(join(installation, 'observed.json'), 'utf8'));
  expect(observed.args).toEqual(expect.arrayContaining(['--locked', '--no-install-project', '--managed-python', '--no-config']));
  expect(observed.env.HOME).toBe(join(installation, 'home'));
  expect(JSON.stringify(observed)).not.toContain('private-sentinel');
  const record = JSON.parse(await readFile(join(result.engineDirectory, 'ready', `${result.identity.id}.json`), 'utf8')) as EngineRecord;
  expect(validRecord(record, result.identity)).toBe(true);
  expect(record.installation).not.toContain('/');
  expect(await installEngine(options())).toMatchObject({ origin: 'reused', pythonExecutable: result.pythonExecutable });
  expect(await readdir(join(result.engineDirectory, 'installations'))).toHaveLength(1);
});
it('keeps both completed installations usable under concurrent publication without a lock', async () => {
  const results = await Promise.all([installEngine(options()), installEngine(options())]);
  expect(results.map(result => result.origin)).toEqual(['installed', 'installed']);
  expect(results[0]!.pythonExecutable).not.toBe(results[1]!.pythonExecutable);
  const installed = await inspectEngine({ engineDirectory: options().engineDirectory });
  expect(installed.status).toBe('ready');
  if (installed.status === 'ready') expect(results.map(result => result.pythonExecutable)).toContain(installed.pythonExecutable);
  for (const result of results) expect(await readFile(result.pythonExecutable, 'utf8')).toContain('ready');
  expect(await readdir(join(options().engineDirectory, 'ready'))).toHaveLength(1);
});
it('ignores incomplete installations and refuses malformed or foreign readiness records', async () => {
  const { identity } = await engineDefinition();
  const root = options().engineDirectory;
  await mkdir(join(root, 'installations', 'unfinished'), { recursive: true });
  expect(await inspectEngine({ engineDirectory: root })).toMatchObject({ status: 'missing' });
  await mkdir(join(root, 'ready'));
  for (const record of ['bad json', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, identity, installation: '../elsewhere' })]) {
    await writeFile(join(root, 'ready', `${identity.id}.json`), record);
    expect(await inspectEngine({ engineDirectory: root })).toMatchObject({ status: 'incompatible', code: 'ENGINE_RECORD_INVALID' });
    await expect(installEngine(options())).rejects.toMatchObject({ code: 'ENGINE_INCOMPATIBLE' });
    expect(await readFile(join(root, 'ready', `${identity.id}.json`), 'utf8')).toBe(record);
  }
  expect(await readdir(join(root, 'installations'))).toEqual(['unfinished']);
});
it('preserves the previous reference when a replacement fails and cleans only its own attempt', async () => {
  const previous = await installEngine(options());
  await writeFile(previous.pythonExecutable, `#!${process.execPath}\nprocess.exit(1);\n`);
  const reference = join(previous.engineDirectory, 'ready', `${previous.identity.id}.json`);
  const bytes = await readFile(reference);
  await writeFile(tool, `#!${process.execPath}\nprocess.stderr.write('error: ' + 'resolution detail '.repeat(1000));\nprocess.exit(12);\n`);
  await expect(installEngine(options())).rejects.toMatchObject({ code: 'INSTALL_FAILED', details: { diagnostic: { exitCode: 12, output: `error: ${'resolution detail '.repeat(1000)}` } } });
  expect(await readFile(reference)).toEqual(bytes);
  expect(await readdir(join(previous.engineDirectory, 'installations'))).toHaveLength(1);
});
it('cancels before publication even when an event hook throws, leaving no ready environment', async () => {
  const controller = new AbortController();
  await expect(installEngine(options(), { signal: controller.signal, onEvent: event => {
    if (event.stage === 'publishing') { controller.abort(); throw new Error('caller'); }
  } })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(await inspectEngine({ engineDirectory: options().engineDirectory })).toMatchObject({ status: 'missing' });
  expect(await readdir(join(options().engineDirectory, 'installations'))).toEqual([]);
});
/**
 * Runs runCommand's own timers on a fake clock: once the command has written its pid file, the clock moves in steps,
 * with real process I/O let through between them, until the call settles.
 */
async function pastDeadline(call: Promise<string>, pidPath: string): Promise<string> {
  let settled = false; const result = call.finally(() => { settled = true; }); result.catch(() => {});
  const turn = () => new Promise(resolve => setImmediate(resolve));
  for (;;) { try { await readFile(pidPath, 'utf8').then(text => { if (!text.trim()) throw new Error('Empty.'); }); break; } catch { await turn(); } }
  while (!settled) { await vi.advanceTimersByTimeAsync(20); await turn(); }
  return result;
}
it('bounds a stalled subprocess, confirms its death and keeps errors off caller streams', async () => {
  const pidPath = join(directory, 'pid');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await expect(pastDeadline(runCommand('/bin/sh', ['-c', 'echo $$ > pid; exec sleep 60'], directory, {}, new AbortController().signal, 500), pidPath)).rejects.toMatchObject({ code: 'TIMEOUT' });
  vi.useRealTimers();
  const pid = Number(await readFile(pidPath, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('pins the readiness format and isolates different dependency identities', async () => {
  const record = JSON.parse(await readFile(new URL('../fixtures/engine-record-v1.json', import.meta.url), 'utf8'));
  const identity = identifyEngine('fixture project', 'fixture lock');
  expect(record.identity).toEqual(identity);
  expect(validRecord(record, identity)).toBe(true);
  expect(validRecord({ ...record, version: 2 }, identity)).toBe(false);
  expect(validRecord(record, identifyEngine('fixture project', 'another lock'))).toBe(false);
  expect(validRecord(record, identifyEngine('another project', 'fixture lock'))).toBe(false);
});

it('allows an explicit later call after installing a previously missing engine', async () => {
  const editor = createImageClient({ engineDirectory: options().engineDirectory });
  const request = { prompt: 'Neutral', model: 'fixture', outputPath: join(directory, 'out.png') };
  try {
    await expect(editor.generate(request)).rejects.toMatchObject({ code: 'ENGINE_MISSING' });
    await installEngine(options());
    await expect(editor.generate(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  } finally { await editor.dispose(); }
});

it('terminates compiler descendants even after the installer parent closes its pipes', async () => {
  const pidPath = join(directory, 'compiler-pid');
  // The compiler ignores SIGTERM and holds none of the installer's pipes.
  const parent = '(trap "" TERM; exec sleep 60) </dev/null >/dev/null 2>&1 & echo $! > compiler-pid; exec sleep 60';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await expect(pastDeadline(runCommand('/bin/sh', ['-c', parent], directory, {}, new AbortController().signal, 500), pidPath)).rejects.toMatchObject({ code: 'TIMEOUT' });
  vi.useRealTimers();
  const pid = Number(await readFile(pidPath, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
});

it('preserves unsettled-process evidence over a simultaneous cancellation', async () => {
  const controller = new AbortController();
  const failure = new PicPatchSdkError('TERMINATION_FAILED', 'Writer still exists');
  await expect(withDeadline(controller.signal, 1000, 'Deadline', async () => {
    controller.abort(); throw failure;
  })).rejects.toBe(failure);
});

it('keeps DreamO and MFLUX installations distinct in one caller-selected engine home', async () => {
  const mflux = await installEngine(options());
  const dreamo = await installEngine({ ...options(), runtime: 'dreamo' });
  expect(dreamo.identity.dependencies).toBe('dreamo-inference');
  expect(dreamo.pythonExecutable).not.toBe(mflux.pythonExecutable);
  expect(await inspectEngine({ engineDirectory: dreamo.engineDirectory, runtime: 'dreamo' })).toMatchObject({ status: 'ready', pythonExecutable: dreamo.pythonExecutable });
  expect(await inspectEngine({ engineDirectory: mflux.engineDirectory })).toMatchObject({ status: 'ready', pythonExecutable: mflux.pythonExecutable });
});

it('waits for disappearance after transient process-group permission errors during teardown', async () => {
  const script = join(directory, 'teardown.mjs');
  await writeFile(script, 'setInterval(()=>{},1000);');
  const originalKill = process.kill.bind(process);
  let observed = false;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal === 0 && !observed) {
      observed = true;
      throw Object.assign(new Error('Group is being reaped'), { code: 'EPERM' });
    }
    return originalKill(pid, signal);
  });
  try {
    await expect(runCommand(process.execPath, [script], directory, {}, new AbortController().signal, 500)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(observed).toBe(true);
  } finally { spy.mockRestore(); }
});

it('reads an engine tool’s output whole, however long', async () => {
  const text = `${'resolved package\n'.repeat(10_000)}é—end`;
  const output = await runCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], process.cwd(), process.env, new AbortController().signal, 10_000);
  expect(output).toBe(text);
});
