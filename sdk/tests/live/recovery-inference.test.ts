import { inferenceOptions } from '../helpers/engine.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createImageClient, prepareModel, type ImageClientOptions, type SdkEvent } from 'picpatchsdk';
import { inferenceConfig, nativeInferenceConfigPath } from '../helpers/live-cache.ts';

const exec = promisify(execFile);
async function children(): Promise<number[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,comm=']);
  const rows = stdout.trim().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
  });
  const owned = new Set(rows.filter(row => row.parent === process.pid && /(?:python|sd-cli)/i.test(row.command)).map(row => row.pid));
  // Include runtime helper processes, even after their parent subsequently exits.
  let count: number;
  do {
    count = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  } while (owned.size !== count);
  return [...owned].sort((a, b) => a - b);
}
async function gone(pids: number[]) {
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  expect(await children()).toEqual([]);
}

it('recovers native sessions after real loading cancellation and protects prior artifacts through repeated 512px edits', async () => {
  const config = JSON.parse(await readFile(nativeInferenceConfigPath(), 'utf8'));
  const prepared = await prepareModel('sd15', { directory: config.directory, checkpoint: config.sd15Checkpoint });
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-native-recovery-'));
  const editor = createImageClient({ model: prepared.model, nativeExecutable: config.executable,
    defaults: { outputDirectory: directory, size: { width: 512, height: 512 }, seed: 42 } });
  const events: SdkEvent[] = [];
  try {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const cancelled = expect(editor.generate({ prompt: 'A ceramic bowl.', parameters: { steps: 10000 }, outputPath: join(directory, 'cancelled.png') }, {
      signal: controller.signal, onEvent: event => { events.push(event); if (event.stage === 'generating') started.resolve(); },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    await Promise.race([started.promise, cancelled]);
    // Observe the actual owned process before cancelling, rather than guessing load duration.
    let pids: number[] = [];
    try {
      while ((pids = await children()).length === 0) await new Promise(resolve => setImmediate(resolve));
    } finally { controller.abort(); }
    await cancelled; await gone(pids);
    expect(await readdir(directory)).toEqual([]);
    let result = await editor.generate({ prompt: 'A blue ceramic bowl on a wooden table.', parameters: { steps: 4 }, sidecar: true });
    if (result.status === 'refused') throw new Error(result.code);
    for (const color of ['green', 'red']) {
      const previous = result.image.path; const bytes = await readFile(previous);
      await expect(editor.generate({ prompt: 'A bowl.', outputPath: previous })).resolves.toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' });
      result = await editor.edit({ instruction: `A ${color} ceramic bowl on a wooden table.`, sourceImage: previous, parameters: { steps: 4, strength: 0.5 }, sidecar: true });
      if (result.status === 'refused') throw new Error(result.code);
      expect(await readFile(previous)).toEqual(bytes);
      expect(result.image.size).toEqual({ width: 512, height: 512 });
      expect((await sharp(result.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
      await gone([]);
    }
    expect(events.filter(event => ['succeeded', 'failed', 'cancelled'].includes(event.stage)).map(event => event.stage)).toEqual(['cancelled']);
    expect((await readdir(directory)).some(name => name.startsWith('.picpatch-'))).toBe(false);
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('recovers from cooperative MFLUX cancellation and survives failing progress hooks for real 512px inference', async () => {
  const config = await inferenceConfig() as ImageClientOptions;
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-mflux-recovery-'));
  const options: ImageClientOptions = { ...inferenceOptions(config), defaults: { outputDirectory: directory, size: { width: 512, height: 512 }, seed: 42 } };
  let editor = createImageClient(options);
  const pids: number[] = [];
  try {
    const controller = new AbortController(); let sawStep = false;
    await expect(editor.generate({ prompt: 'A blue ceramic bowl.', parameters: { steps: 4 } }, {
      signal: controller.signal, onProgress: event => {
        if (event.stage === 'generating' && event.completed !== undefined && event.completed >= 1) { sawStep = true; controller.abort(); }
      },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sawStep).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    pids.push(...await children()); expect(pids.length).toBeGreaterThan(0);
    const generated = await editor.generate({ prompt: 'A green ceramic bowl on a table.', parameters: { steps: 2 }, sidecar: true });
    if (generated.status === 'refused') throw new Error(generated.code);
    expect(await children()).toEqual(pids);
    expect((await sharp(generated.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
    const original = await readFile(generated.image.path);
    // A broken caller progress hook must not stop inference or poison the worker.
    const afterHookFailure = await editor.edit({ instruction: 'Make the bowl red.', sourceImage: generated.image.path, parameters: { steps: 4 } }, {
      onProgress: event => { if (event.stage === 'editing' && event.completed !== undefined) throw new Error('consumer callback failed'); },
    });
    if (afterHookFailure.status === 'refused') throw new Error(afterHookFailure.code);
    expect((await sharp(afterHookFailure.image.path).metadata()).width).toBe(512);
    expect(await children()).toEqual(pids);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    // Process exit has no event to await here; the poll is unbounded.
    await expect.poll(children, { timeout: 2 ** 31 - 1 }).toEqual([]);
    await gone(pids);
    // Allow Node's close event to confirm pipes are closed before the next explicit call.
    await new Promise(resolve => setTimeout(resolve, 50));
    const edited = await editor.edit({ instruction: 'Make the bowl yellow.', sourceImage: generated.image.path, parameters: { steps: 2 }, sidecar: true });
    if (edited.status === 'refused') throw new Error(edited.code);
    expect(edited.image.size).toEqual({ width: 512, height: 512 });
    expect((await sharp(edited.image.path).stats()).channels.some(channel => channel.stdev > 1)).toBe(true);
    expect(await readFile(generated.image.path)).toEqual(original);
    pids.push(...await children());
    await editor.dispose(); await gone(pids);
    expect(await readdir(directory)).toHaveLength(5);
  } finally { await editor.dispose(); await rm(directory, { recursive: true, force: true }); }
});
