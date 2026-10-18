import { describe, expect, it } from 'vitest';
import { decodeResponse, encodeRequest, ProtocolSession, validateRequest, validateResponse } from '../../src/worker/protocol.ts';
import fixtures from '../fixtures/protocol.json' with { type: 'json' };
const hello = { version: 1, id: 1, type: 'hello' } as const;
const ready = { version: 1, id: 1, type: 'ready', workerVersion: 'test', models: [] };
const edit = { version: 1, id: 2, type: 'edit', request: { model: 'test', instruction: 'Edit', sourceImage: '/in.png', outputPath: '/out.png' } } as const;
const error = { version: 1, id: 2, type: 'error', error: { code: 'BACKEND_UNAVAILABLE', kind: 'unavailable', effect: 'none', details: {}, message: 'Unavailable' } };
const progress = { version: 1, id: 2, type: 'progress', event: { type: 'progress', verb: 'edit', stage: 'editing', message: 'Editing', completed: 1, total: 2 } };
function started() { const session = new ProtocolSession(); session.send(hello); session.receive(JSON.stringify(ready)); return session; }

describe('shared protocol corpus', () => {
  for (const fixture of fixtures) it(fixture.name, () => {
    const validate = fixture.kind === 'Request' ? validateRequest : validateResponse;
    if (fixture.valid) expect(() => validate(fixture.message)).not.toThrow();
    else expect(() => validate(fixture.message)).toThrow();
  });
});
describe('worker protocol', () => {
  it('encodes escaped newlines without breaking framing', () => {
    const encoded = encodeRequest({ ...edit, request: { ...edit.request, instruction: 'Line one\nLine two 日本語' } });
    expect(encoded.split('\n')).toHaveLength(2);
    expect(JSON.parse(encoded).request.instruction).toContain('日本語');
  });
  it.each(['bad', '{}', 'null', JSON.stringify({ ...ready, version: 2 }), JSON.stringify(ready)+'\n', JSON.stringify({ ...ready, extra: true })])('rejects malformed replies: %s', line => {
    expect(() => decodeResponse(line)).toThrow();
  });
  it('requires handshake and monotonic IDs', () => {
    const session = new ProtocolSession();
    expect(() => session.send(edit)).toThrow();
    session.send(hello);
    expect(() => session.send(edit)).toThrow();
    session.receive(JSON.stringify(ready));
    expect(() => session.send(hello)).toThrow();
  });
  it('correlates progress and exactly one terminal reply', () => {
    const session = started(); session.send(edit);
    expect(() => session.send({ ...edit, id: 3 })).toThrow();
    expect(() => session.receive(JSON.stringify({ ...error, id: 99 }))).toThrow();
    expect(() => session.receive(JSON.stringify({ ...ready, id: 2 }))).toThrow();
    session.receive(JSON.stringify(progress));
    session.receive(JSON.stringify(error));
    expect(() => session.receive(JSON.stringify(error))).toThrow();
    expect(() => session.receive(JSON.stringify(progress))).toThrow();
    session.send({ ...edit, id: 3 });
  });
  it('keeps cancellation acknowledgement separate from edit termination', () => {
    const session = started(); session.send(edit);
    session.send({ version: 1, id: 3, type: 'cancel', targetId: 2 });
    const ack = { version: 1, id: 3, type: 'cancelAck', targetId: 2, accepted: true };
    expect(() => session.receive(JSON.stringify({ ...ack, targetId: 99 }))).toThrow();
    session.receive(JSON.stringify(ack));
    expect(() => session.send({ version: 1, id: 4, type: 'shutdown' })).toThrow();
    session.receive(JSON.stringify({ ...error, error: { code: 'CANCELLED', kind: 'cancelled', effect: 'none', details: {}, message: 'Cancelled' } }));
    session.send({ version: 1, id: 4, type: 'shutdown' });
    session.receive(JSON.stringify({ version: 1, id: 4, type: 'shutdownAck' }));
    expect(() => session.send({ ...edit, id: 5 })).toThrow();
  });
  it('rejects invalid progress counters', () => {
    for (const event of [{ ...progress.event, completed: 3 }, { ...progress.event, total: undefined }]) {
      expect(() => decodeResponse(JSON.stringify({ ...progress, event }))).toThrow();
    }
  });
});

it('correlates generation, blocks mixed concurrent work, and cancels generation by ID', () => {
  const session = started();
  session.send({ version: 1, id: 2, type: 'generate', request: { model: 'test', prompt: 'A bowl.', outputPath: '/out.png' } });
  expect(() => session.send({ ...edit, id: 3 })).toThrow();
  expect(() => session.receive(JSON.stringify(progress))).toThrow();
  session.receive(JSON.stringify({ ...progress, event: { ...progress.event, verb: 'generate', stage: 'generating' } }));
  session.send({ version: 1, id: 3, type: 'cancel', targetId: 2 });
  session.receive(JSON.stringify({ version: 1, id: 3, type: 'cancelAck', targetId: 2, accepted: true }));
  expect(() => session.send({ ...edit, id: 4 })).toThrow();
  session.receive(JSON.stringify({ ...error, error: { code: 'CANCELLED', kind: 'cancelled', effect: 'none', details: {}, message: 'Cancelled' } }));
  session.send({ ...edit, id: 4 });
});
