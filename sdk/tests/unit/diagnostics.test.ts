import { expect, it } from 'vitest';
import { inspectModel, prepareModel, listModels, type SdkEvent } from '../../src/index.ts';
import { withDiagnostics } from '../../src/diagnostics.ts';
import { emitProgress } from '../../src/operations.ts';
import { PicPatchSdkError } from '../../src/errors.ts';
import { ProtocolSession } from '../../src/worker/protocol.ts';

it('emits one invocation ID and one safe terminal error without serializing exception text or paths', async () => {
  const events: SdkEvent[] = [];
  await expect(inspectModel('/missing/private-sentinel', { onEvent: event => events.push(event) })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  expect(events.filter(event => event.name !== 'sdk.startup').map(event => event.stage)).toEqual(['started', 'inspecting', 'failed']);
  expect(new Set(events.map(event => event.operationId)).size).toBe(1);
  expect(JSON.stringify(events)).not.toContain('private-sentinel');
  expect(events.at(-1)?.error?.code).toBe('FILE_NOT_FOUND');
});
it('routes progress and diagnostics from the same event owner without letting sink failures mask results', async () => {
  const stages: string[] = [];
  const result = await withDiagnostics('fixture', { onEvent: (event: SdkEvent) => { if (event.name !== 'sdk.startup') stages.push(event.stage); throw new Error('sink'); } }, async options => {
    emitProgress(options, { stage: 'working', completed: 1, total: 1 }); return 42;
  });
  expect(result).toBe(42); expect(stages).toEqual(['started', 'working', 'succeeded']);
});
it('ignores progress errors and preserves the original failure when an event sink fails', async () => {
  const error = new PicPatchSdkError('MODEL_IO', 'private sentinel');
  await expect(withDiagnostics('fixture', { onEvent: () => { throw new Error('sink'); } }, async () => { throw error; })).rejects.toBe(error);
  await expect(withDiagnostics('fixture', {}, async options => {
    emitProgress({ ...options, onProgress: () => { throw error; } }, { stage: 'working', completed: 1, total: 1 });
  })).resolves.toBeUndefined();
});
it('does not await blocked caller logging and reports cancellation as cancellation', async () => {
  expect(await withDiagnostics('fixture', { onEvent: () => new Promise<void>(() => {}) }, async () => 1)).toBe(1);
  const events: SdkEvent[] = [];
  await expect(prepareModel(listModels()[0]!.id, { signal: AbortSignal.abort(), onEvent: event => events.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(events.filter(e => e.name !== 'sdk.startup').map(e => e.stage)).toEqual(['started', 'cancelled']);
});
it('rejects malformed worker diagnostics instead of forwarding arbitrary private fields', () => {
  const session = new ProtocolSession();
  session.send({ version: 1, id: 1, type: 'hello' });
  expect(() => session.receive(JSON.stringify({ version: 1, id: 1, type: 'error', error: { code: 'RUNTIME_FAILURE', kind: 'internal', effect: 'none', details: { diagnostic: { phase: 'loading', causes: [{ kind: 'Exception', message: 'private sentinel' }] } }, message: 'Failed' } }))).toThrow(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
});

it('contains rejected progress hooks and reports them once through the separate event hook', async () => {
  const events: SdkEvent[] = [];
  const result = await withDiagnostics('fixture', { onEvent: (event: SdkEvent) => events.push(event), onProgress: async () => { throw new Error('private hook failure'); } }, async options => {
    emitProgress(options, { stage: 'working', completed: 1, total: 1 });
    emitProgress(options, { stage: 'working', completed: 1, total: 1 });
    await Promise.resolve();
    return 42;
  });
  expect(result).toBe(42);
  expect(events.filter(event => event.stage === 'hook-failed')).toHaveLength(1);
  expect(events.at(-1)?.stage).toBe('succeeded');
  expect(JSON.stringify(events)).not.toContain('private hook failure');
});
it('does not recurse into a failed asynchronous event hook or wait for progress sinks', async () => {
  let calls = 0;
  expect(await withDiagnostics('fixture', { onEvent: async (event: SdkEvent) => { if (event.name !== 'sdk.startup') calls++; throw new Error('sink'); }, onProgress: () => new Promise<void>(() => {}) }, async options => {
    emitProgress(options, { stage: 'working', completed: 1, total: 1 }); return 1;
  })).toBe(1);
  await Promise.resolve();
  expect(calls).toBe(3);
});
