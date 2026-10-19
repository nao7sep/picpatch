import type { ProgressEvent } from '../contracts.generated.ts';
import type { WorkerDiagnostic } from '../diagnostics.ts';
import { contractAjv } from '../contracts.ts';
import { PicPatchSdkError, isPicPatchSdkError, type PicPatchSdkErrorData } from '../errors.ts';
import { validateEditRequest, validateGenerateRequest } from '../validation.ts';
import type { GenerateRequest, EditRequest, ModelCapabilities } from '../types.ts';
import type { EditResult } from '../contracts.generated.ts';
import type { LocalModel } from '../contracts.generated.ts';
import schema from '../../protocol/worker.schema.json' with { type: 'json' };

export interface RuntimeCheck { status: 'imports-ready' | 'load-ready' | 'missing-package' | 'unsupported-version' | 'import-failed' | 'load-failed'; version?: string }

type Envelope<T extends string> = { version: 1; id: number; type: T };
export type WorkerRequest = Envelope<'shutdown'> | (Envelope<'hello'> & { model?: LocalModel; runtimeCheck?: 'imports' | 'load' }) |
  (Envelope<'generate'> & { request: GenerateRequest }) | (Envelope<'edit'> & { request: EditRequest }) | (Envelope<'cancel'> & { targetId: number });
export type WorkerResponse = (Envelope<'ready'> & { workerVersion: string; models: ModelCapabilities[]; runtimeCheck?: RuntimeCheck }) |
  (Envelope<'progress' | 'event'> & { event: ProgressEvent }) | (Envelope<'result'> & { result: EditResult }) |
  (Envelope<'error'> & { error: PicPatchSdkErrorData }) |
  (Envelope<'cancelAck'> & { targetId: number; accepted: boolean }) | Envelope<'shutdownAck'>;
contractAjv.addSchema(schema, 'worker.schema.json');
const requestValid = contractAjv.compile<WorkerRequest>({ $ref: 'worker.schema.json#/definitions/Request' });
const responseValid = contractAjv.compile<WorkerResponse>({ $ref: 'worker.schema.json#/definitions/Response' });
function fail(message: string): never { throw new PicPatchSdkError('PROTOCOL_ERROR', message); }

export function validateRequest(value: unknown): asserts value is WorkerRequest {
  if (!requestValid(value)) fail('Invalid worker request or unsupported protocol version.');
  if (value.type === 'generate') validateGenerateRequest(value.request);
  if (value.type === 'edit') validateEditRequest(value.request);
}
export function validateResponse(value: unknown): asserts value is WorkerResponse {
  if (!responseValid(value)) fail('Invalid worker response or unsupported protocol version.');
  if (value.type === 'error' && !isPicPatchSdkError(value.error)) fail('Invalid worker error code or kind.');
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
    if ((request.type === 'edit' || request.type === 'generate') && [...this.pending.values()].some(item => item.type === 'edit' || item.type === 'generate')) fail('An image operation is already pending.');
    if (request.type === 'cancel' && !['edit', 'generate'].includes(this.pending.get(request.targetId)?.type ?? '')) fail('Cancellation must target a pending image operation.');
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
    const expected = { hello: ['ready'], edit: ['progress', 'event', 'result'], generate: ['progress', 'event', 'result'], cancel: ['cancelAck'], shutdown: ['shutdownAck'] };
    if (response.type !== 'error' && !expected[request.type].includes(response.type)) fail('Response does not match the request operation.');
    if (response.type === 'cancelAck' && request.type === 'cancel' && response.targetId !== request.targetId) fail('Cancellation acknowledgement targets the wrong edit.');
    if ((response.type === 'progress' || response.type === 'event') && response.event.verb !== request.type) fail('Progress does not match the requested operation.');
    if (response.type !== 'progress' && response.type !== 'event') this.pending.delete(response.id);
    if (request.type === 'hello') this.state = response.type === 'ready' ? 'ready' : 'closed';
    if (request.type === 'shutdown') this.state = 'closed';
    return response;
  }
}
