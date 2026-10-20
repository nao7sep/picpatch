import { fixtureEditor } from '../helpers/editor.ts';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { validateEditRequest, type ModelCapabilities, type EditRequest } from '../../src/index.ts';
import { WorkerProcess } from '../../src/worker/process.ts';
import { ProtocolSession } from '../../src/worker/protocol.ts';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/klein-contract.json', import.meta.url), 'utf8')) as {
  capabilities: ModelCapabilities; cases: { name: string; request: EditRequest }[];
};
afterEach(() => vi.restoreAllMocks());

it.each(fixture.cases)('accepts the shared Klein conditioning case: $name', ({ request }) => {
  expect(validateEditRequest(request, fixture.capabilities)).toEqual(request);
});
it('validates the full capability advertisement across the worker boundary', () => {
  const session = new ProtocolSession();
  session.send({ version: 1, id: 1, type: 'hello' });
  expect(session.receive(JSON.stringify({ version: 1, id: 1, type: 'ready', workerVersion: 'test', models: [fixture.capabilities] }))).toMatchObject({ models: [fixture.capabilities] });
  expect(() => validateEditRequest(fixture.cases[1]!.request, { ...fixture.capabilities, sourceImageRequired: true })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  expect(() => validateEditRequest(fixture.cases[0]!.request, { ...fixture.capabilities, referenceConditioning: 'native-role-controls' } as never)).toThrow(expect.objectContaining({ code: 'PROTOCOL_ERROR' }));
});
it.each([{ size: { width: 17, height: 32 } }])('editing rejects unsupported metadata before image I/O (%j)', async change => {
  vi.spyOn(WorkerProcess.prototype, 'start').mockResolvedValue({ version: 1, id: 1, type: 'ready', workerVersion: 'test', models: [fixture.capabilities] });
  const edit = vi.spyOn(WorkerProcess.prototype, 'edit');
  vi.spyOn(WorkerProcess.prototype, 'dispose').mockResolvedValue();
  const editor = fixtureEditor({ pythonExecutable: '/unused-python' });
  const progress = vi.fn();
  try {
    await expect(editor.edit({ ...fixture.cases[0]!.request, ...change }, { onProgress: progress })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(progress).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  } finally { await editor.dispose(); }
});
