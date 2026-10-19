import { workerLaunch } from '../../src/backends/python/launch.ts';
import { testEngineDirectory } from '../helpers/engine.ts';
import { testPython } from '../helpers/python.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createImageClient, type ImageClient, type EditRequest } from '../../src/index.ts';
import { ProcessEditor } from '../../src/execution/worker-backend.ts';
import { WorkerProcess, type WorkerLaunch } from '../../src/worker/process.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/lifecycle-worker.ts', import.meta.url));
const request: EditRequest = { model: 'test', instruction: 'Edit', sourceImage: '/in.png', outputPath: '/out.png', seed: 1 };
const editors: Pick<ImageClient, 'dispose'>[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
function tracked(launch: WorkerLaunch): ProcessEditor {
  const worker = new WorkerProcess(launch, { startupMs: 5_000, editMs: 5_000, cancellationMs: 100, shutdownMs: 1_000, terminationMs: 100 }, config => {
    const child = spawn(config.executable, config.args, { cwd: config.cwd, stdio: 'pipe', detached: process.platform !== 'win32' });
    children.push(child); return child;
  });
  const editor = new ProcessEditor(worker); editors.push(editor); return editor;
}
function fixtureEditor(mode = 'normal') { return tracked({ executable: process.execPath, args: [fixture, mode], cwd: root }); }

afterEach(async () => {
  await Promise.allSettled(editors.splice(0).map(editor => editor.dispose()));
  for (const child of children.splice(0)) {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (child.pid) expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }
});

describe('real model-free worker processes', () => {
  it('reuses one process and confirms it exits on disposal', async () => {
    const editor = fixtureEditor();
    expect(await editor.edit(request)).toMatchObject({ seed: 1 });
    expect(await editor.edit(request)).toMatchObject({ seed: 1 });
    expect(children).toHaveLength(1);
    await editor.dispose();
    expect(children[0]!.exitCode).toBe(0);
  });
  it('forcibly closes a worker that ignores cancellation and SIGTERM', async () => {
    const editor = fixtureEditor('ignore-cancel'); const controller = new AbortController();
    await expect(editor.edit(request, { signal: controller.signal, onEvent: event => { if (event.stage === 'editing') controller.abort(); } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(children[0]!.signalCode).toBe('SIGKILL');
  });
  it.each(['malformed', 'exit'])('cleans up after %s output', async mode => {
    const editor = fixtureEditor(mode);
    const failure = await editor.edit(request).catch(error => error);
    expect(failure).toMatchObject(mode === 'exit' ? { code: 'WORKER_EXITED', kind: 'unavailable', details: { diagnostic: { exitCode: 7 } } } : { code: 'PROTOCOL_ERROR', kind: 'internal' });
    expect(failure.code).not.toBe('TERMINATION_FAILED');
  });
  it('runs the bundled Python handshake and verifies process closure', async () => {
    const python = testPython;
    const editor = tracked(workerLaunch(python));
    await expect(editor.edit(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await editor.dispose(); expect(children[0]!.exitCode).toBe(0);
  });
  it('exercises the public factory with the installed Python environment', async () => {
    const editor = createImageClient({ engineDirectory: testEngineDirectory });
    editors.push(editor);
    const directory = await mkdtemp(join(tmpdir(), 'picpatch-live-'));
    const source = join(directory, 'source.png');
    try {
      await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } }).png().toFile(source);
      await expect(editor.edit({ ...request, sourceImage: source, outputPath: join(directory, 'out.png') })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
      await editor.dispose();
      await expect(editor.edit(request)).rejects.toMatchObject({ code: 'DISPOSED' });
    } finally {
      await editor.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
