import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ImageEditor } from '../../src/execution/session.ts';
import type { EditBackend } from '../../src/execution/backend.ts';
import type { ImageRequest, OperationOptions } from '../../src/types.ts';
import { PicPatchSdkError } from '../../src/errors.ts';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-queue-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const request = (prompt: string) => ({ model: 'test', prompt, outputPath: join(directory, `${prompt}.png`), seed: 1 });
function setup() {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const seen: ImageRequest[] = [];
  let validations = 0;
  const render = async (input: ImageRequest) => {
    seen.push(structuredClone(input));
    await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toFile(input.outputPath);
    return { image: { path: input.outputPath, mimeType: 'image/png' as const, size: { width: 16, height: 16 } }, model: 'test', seed: input.seed!, effectiveParameters: {}, modelRevision: 'test', runtime: { name: 'test', version: '1' }, references: [] };
  };
  const backend: EditBackend = {
    validate: async () => { if (++validations === 1) { entered.resolve(); await release.promise; } return { model: 'test', textToImage: true, instructionEditing: true, referenceRoles: [], maskMode: 'none' }; },
    generate: render, edit: render, dispose: async () => {},
  };
  return { editor: new ImageEditor(backend), entered, release, seen };
}
it('runs submissions in order and snapshots request/options before any callback or wait', async () => {
  const { editor, entered, release, seen } = setup();
  const first = editor.generate(request('first'));
  await entered.promise;
  const input = { ...request('second'), parameters: { steps: 2 } };
  const options: OperationOptions = { signal: new AbortController().signal };
  const second = editor.generate(input, options);
  input.prompt = 'mutated'; input.parameters.steps = 99;
  Object.assign(options, { signal: AbortSignal.abort(), timeoutMs: 1 });
  expect(seen).toEqual([]);
  release.resolve();
  try { await first; await second; expect(seen.map(r => 'prompt' in r ? r.prompt : '')).toEqual(['first', 'second']); expect(seen[1]!.parameters).toEqual({ steps: 2 }); }
  finally { await editor.dispose(); }
});
it('settles cancelled and expired waiters promptly without letting later work overtake active work', async () => {
  const { editor, entered, release, seen } = setup();
  const first = editor.generate(request('first')); await entered.promise;
  const cancel = new AbortController();
  const waiting = editor.generate(request('cancelled'), { signal: cancel.signal });
  const caught = expect(waiting).rejects.toMatchObject({ code: 'CANCELLED', kind: 'cancelled', effect: 'none' });
  cancel.abort(); await caught;
  await expect(editor.generate(request('expired'), { timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT', effect: 'none' });
  const last = editor.generate(request('last'));
  expect(seen).toEqual([]); expect(await readdir(directory)).toEqual([]);
  release.resolve();
  try { await first; await last; expect(seen.map(r => 'prompt' in r ? r.prompt : '')).toEqual(['first', 'last']); }
  finally { await editor.dispose(); }
});
it('keeps independent editors independent and continues after a failed operation without replay', async () => {
  const a = setup(); const b = setup();
  const pending = a.editor.generate(request('a')); await a.entered.promise;
  const other = b.editor.generate(request('b')); await b.entered.promise; b.release.resolve();
  try {
    await other; expect(a.seen).toEqual([]);
    a.release.resolve(); await pending;
    await expect(a.editor.generate(request('a'))).resolves.toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT', effect: 'none' });
    await a.editor.generate(request('later')); expect(a.seen).toHaveLength(2);
  } finally { await a.editor.dispose(); await b.editor.dispose(); }
});
it('does not let cancellation replace evidence of an unconfirmed writer', async () => {
  const controller = new AbortController();
  const backend: EditBackend = { validate: async () => ({ model: 'test', textToImage: true, instructionEditing: false, referenceRoles: [], maskMode: 'none' }),
    generate: async () => { controller.abort(); throw new PicPatchSdkError('TERMINATION_FAILED', 'Unknown writer'); },
    edit: async () => { throw new Error('Unexpected edit'); }, dispose: async () => {} };
  const editor = new ImageEditor(backend);
  try { await expect(editor.generate(request('unknown'), { signal: controller.signal })).rejects.toMatchObject({ code: 'TERMINATION_FAILED', effect: 'unknown', details: { recoveryDirectory: expect.any(String) } }); }
  finally { await editor.dispose(); }
});

it('continues queued independent work after a settled failure without retrying the failed request', async () => {
  const seen: string[] = [];
  const backend: EditBackend = {
    validate: async () => ({ model: 'test', textToImage: true, instructionEditing: false, referenceRoles: [], maskMode: 'none' }),
    generate: async input => {
      seen.push(input.prompt);
      if (input.prompt === 'failed') throw new PicPatchSdkError('RUNTIME_FAILURE', 'Fixture failure');
      await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toFile(input.outputPath);
      return { image: { path: input.outputPath, mimeType: 'image/png', size: { width: 16, height: 16 } }, model: 'test', seed: 1, effectiveParameters: {}, modelRevision: 'test', runtime: { name: 'test', version: '1' }, references: [] };
    }, edit: async () => { throw new Error('Unexpected edit'); }, dispose: async () => {},
  };
  const editor = new ImageEditor(backend);
  const failed = expect(editor.generate(request('failed'))).rejects.toMatchObject({ code: 'RUNTIME_FAILURE', effect: 'none' });
  const next = editor.generate(request('next'));
  try { await failed; await next; expect(seen).toEqual(['failed', 'next']); expect(await readdir(directory)).toEqual(['next.png']); }
  finally { await editor.dispose(); }
});
