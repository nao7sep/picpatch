import { expect, it } from 'vitest';
import { createEditor, type LocalEditingModel } from '../../src/index.ts';
import { ProtocolSession } from '../../src/worker/protocol.ts';
const model: LocalEditingModel = {
  variant: 'flux2-klein-4b', directory: '/models/klein',
  manifest: { version: 1, model: 'klein', source: { repository: 'local', revision: 'a'.repeat(40) },
    components: [{ path: 'weights.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] },
};
it.each(['relative', '/models/\0bad'])('rejects invalid local model directory %s synchronously', directory => {
  expect(() => createEditor({ pythonExecutable: '/python', model: { ...model, directory } })).toThrow();
});
it('rejects unsupported adapters and invalid manifests without spawning', () => {
  expect(() => createEditor({ pythonExecutable: '/python', model: { ...model, variant: 'unknown' } as unknown as LocalEditingModel })).toThrow();
  expect(() => createEditor({ pythonExecutable: '/python', model: { ...model, manifest: { ...model.manifest, components: [{ path: '../weights', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] } } })).toThrow();
});
it('validates a model registration through the shared handshake schema', () => {
  const session = new ProtocolSession();
  expect(JSON.parse(session.send({ version: 1, id: 1, type: 'hello', model }))).toEqual({ version: 1, id: 1, type: 'hello', model });
});
it('creating and disposing a configured editor does no file IO or inference', async () => {
  const editor = createEditor({ pythonExecutable: '/does-not-exist', model });
  await editor.dispose();
});
