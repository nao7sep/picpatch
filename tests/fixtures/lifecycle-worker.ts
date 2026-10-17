/** Model-free subprocess fixture. Produces metadata only; never opens images. */
import { createInterface } from 'node:readline';
import type { WorkerRequest } from '../../src/worker/protocol.ts';
const mode = process.argv[2] ?? 'normal';
if (mode === 'ignore-cancel') process.on('SIGTERM', () => {});
const lines = createInterface({ input: process.stdin });
const reply = (id: number, type: string, fields: object = {}) => process.stdout.write(JSON.stringify({ version: 1, id, type, ...fields })+'\n');
lines.on('line', line => {
  const message = JSON.parse(line) as WorkerRequest;
  if (message.type === 'hello') {
    reply(message.id, 'ready', { workerVersion: 'fixture', models: [{ model: 'test', instructionEditing: true, referenceRoles: ['subject'], maskMode: 'none' }] });
  } else if (message.type === 'edit') {
    process.stderr.write('worker diagnostic\n');
    reply(message.id, 'progress', { event: { type: 'progress', verb: 'edit', stage: 'editing', message: 'Editing 日本語' } });
    if (mode === 'ignore-cancel') return;
    if (mode === 'malformed') { process.stdout.write('not JSON\n'); return; }
    if (mode === 'exit') { process.exit(7); }
    reply(message.id, 'result', { result: {
      image: { path: message.request.outputPath, mimeType: 'image/png', size: { width: 64, height: 64 } },
      model: message.request.model, effectiveParameters: {}, modelRevision: 'fixture', runtime: { name: 'fixture', version: '1' },
      seed: message.request.seed ?? 1, references: message.request.references ?? [],
    } });
  } else if (message.type === 'shutdown') {
    reply(message.id, 'shutdownAck');
    lines.close(); process.stdin.destroy();
  }
});
