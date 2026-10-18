import { expect, it } from 'vitest';
import { inspectModel, prepareModel, listModels, type DiagnosticEvent } from '../../src/index.ts';
import { withDiagnostics } from '../../src/diagnostics.ts';
import { emitProgress } from '../../src/operations.ts';
import { PicPatchRuntimeError } from '../../src/errors.ts';
import { ProtocolSession } from '../../src/worker/protocol.ts';

it('emits one invocation ID and one safe terminal error without serializing exception text or paths', async () => {
  const events: DiagnosticEvent[] = [];
  await expect(inspectModel('/missing/private-sentinel', { onDiagnostic: event => events.push(event) })).rejects.toMatchObject({ code: 'MODEL_IO' });
  expect(events.map(event => event.stage)).toEqual(['started', 'progress', 'failed']);
  expect(new Set(events.map(event => event.operationId)).size).toBe(1);
  expect(JSON.stringify(events)).not.toContain('private-sentinel');
  expect(events.at(-1)?.error?.code).toBe('MODEL_IO');
});
it('routes progress and diagnostics from the same event owner without letting sink failures mask results', async () => {
  const stages: string[] = [];
  const result = await withDiagnostics('fixture', { onDiagnostic: (event: DiagnosticEvent) => { stages.push(event.stage); throw new Error('sink'); } }, async options => {
    emitProgress(options, { stage: 'working' }); return 42;
  });
  expect(result).toBe(42); expect(stages).toEqual(['started', 'progress', 'succeeded']);
});
it('keeps progress callback errors distinct and preserves the original failure when a terminal sink fails', async () => {
  const error = new PicPatchRuntimeError('MODEL_IO', 'private sentinel');
  await expect(withDiagnostics('fixture', { onDiagnostic: () => { throw new Error('sink'); } }, async () => { throw error; })).rejects.toBe(error);
  await expect(withDiagnostics('fixture', {}, async options => {
    emitProgress({ ...options, onProgress: () => { throw error; } }, { stage: 'working' });
  })).rejects.toMatchObject({ code: 'CALLBACK_FAILED', cause: error });
});
it('does not await blocked caller logging and reports cancellation as cancellation', async () => {
  expect(await withDiagnostics('fixture', { onDiagnostic: () => new Promise<void>(() => {}) }, async () => 1)).toBe(1);
  const events: DiagnosticEvent[] = [];
  await expect(prepareModel(listModels()[0]!.id, { signal: AbortSignal.abort(), onDiagnostic: event => events.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(events.map(e => e.stage)).toEqual(['started', 'cancelled']);
});
it('rejects malformed worker diagnostics instead of forwarding arbitrary private fields', () => {
  const session = new ProtocolSession();
  session.send({ version: 1, id: 1, type: 'hello' });
  expect(() => session.receive(JSON.stringify({ version: 1, id: 1, type: 'error', error: { code: 'RUNTIME_FAILURE', message: 'Failed', diagnostic: { phase: 'loading', causes: [{ kind: 'Exception', message: 'private sentinel' }] } } }))).toThrow(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
});
