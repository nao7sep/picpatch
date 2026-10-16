import { contractAjv } from '../contracts.ts';
import { PicPatchRuntimeError } from '../errors.ts';
import { validateEditRequest } from '../validation.ts';
import type { EditRequest, EditResult, ModelCapabilities, ProgressEvent } from '../types.ts';
import type { LocalEditingModel } from '../contracts.generated.ts';
import schema from '../../protocol/worker.schema.json' with { type: 'json' };

type Envelope<T extends string> = { version: 1; id: number; type: T };
export type WorkerRequest = Envelope<'shutdown'> | (Envelope<'hello'> & { model?: LocalEditingModel }) |
  (Envelope<'edit'> & { request: EditRequest }) | (Envelope<'cancel'> & { targetId: number });
export type WorkerResponse = (Envelope<'ready'> & { workerVersion: string; models: ModelCapabilities[] }) |
  (Envelope<'progress'> & { event: ProgressEvent }) | (Envelope<'result'> & { result: EditResult }) |
  (Envelope<'error'> & { error: { code: 'INVALID_REQUEST' | 'NOT_READY' | 'BACKEND_UNAVAILABLE' | 'BUSY' | 'CANCELLED' | 'RUNTIME_FAILURE'; message: string } }) |
  (Envelope<'cancelAck'> & { targetId: number; accepted: boolean }) | Envelope<'shutdownAck'>;
contractAjv.addSchema(schema, 'worker.schema.json');
const requestValid = contractAjv.compile<WorkerRequest>({ $ref: 'worker.schema.json#/definitions/Request' });
const responseValid = contractAjv.compile<WorkerResponse>({ $ref: 'worker.schema.json#/definitions/Response' });
function fail(message: string): never { throw new PicPatchRuntimeError('PROTOCOL_ERROR', message); }

export function validateRequest(value: unknown): asserts value is WorkerRequest {
  if (!requestValid(value)) fail('Invalid worker request or unsupported protocol version.');
  if (value.type === 'edit') validateEditRequest(value.request);
}
export function validateResponse(value: unknown): asserts value is WorkerResponse {
  if (!responseValid(value)) fail('Invalid worker response or unsupported protocol version.');
  if (value.type === 'progress') {
    const { completed, total } = value.event;
    if ((completed === undefined) !== (total === undefined) || (completed !== undefined && total !== undefined && completed > total)) fail('Invalid progress counters.');
  }
}
export function encodeRequest(value: WorkerRequest): string {
  validateRequest(value);
  return JSON.stringify(value) + '\n';
}
export function decodeResponse(line: string): WorkerResponse {
  if (line.includes('\n') || line.includes('\r')) fail('Expected one JSON frame without its line delimiter.');
  let value: unknown;
  try { value = JSON.parse(line); } catch { return fail('Invalid JSON in worker response.'); }
  validateResponse(value);
  return value;
}

/** Correlates an ordered session without retaining the history of completed calls. */
export class ProtocolSession {
  private state: 'new' | 'starting' | 'ready' | 'closing' | 'closed' = 'new';
  private lastId = 0;
  private readonly pending = new Map<number, WorkerRequest>();

  send(request: WorkerRequest): string {
    const frame = encodeRequest(request);
    if (request.id <= this.lastId) fail('Request IDs must increase within a session.');
    if (this.state === 'closed' || this.state === 'closing') fail('Session is closing or closed.');
    if (request.type === 'hello' ? this.state !== 'new' : this.state !== 'ready') fail('Handshake must complete before other requests.');
    if (request.type === 'edit' && [...this.pending.values()].some(item => item.type === 'edit')) fail('An edit is already pending.');
    if (request.type === 'cancel' && this.pending.get(request.targetId)?.type !== 'edit') fail('Cancellation must target a pending edit.');
    if (request.type === 'shutdown' && this.pending.size !== 0) fail('Settle outstanding operations before shutdown.');
    if (request.type === 'hello') this.state = 'starting';
    if (request.type === 'shutdown') this.state = 'closing';
    this.lastId = request.id;
    this.pending.set(request.id, structuredClone(request));
    return frame;
  }

  receive(line: string): WorkerResponse {
    const response = decodeResponse(line);
    const request = this.pending.get(response.id);
    if (!request) return fail('Response has no pending request.');
    const expected = { hello: ['ready'], edit: ['progress', 'result'], cancel: ['cancelAck'], shutdown: ['shutdownAck'] };
    if (response.type !== 'error' && !expected[request.type].includes(response.type)) fail('Response does not match the request operation.');
    if (response.type === 'cancelAck' && request.type === 'cancel' && response.targetId !== request.targetId) fail('Cancellation acknowledgement targets the wrong edit.');
    if (response.type !== 'progress') this.pending.delete(response.id);
    if (request.type === 'hello') this.state = response.type === 'ready' ? 'ready' : 'closed';
    if (request.type === 'shutdown') this.state = 'closed';
    return response;
  }
}
