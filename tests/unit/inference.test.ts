import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inference, type InferenceSdk } from '../../src/main/core/inference.ts';
import { Sessions } from '../../src/main/core/sessions.ts';
import type { Settings } from '../../src/main/core/settings.ts';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-inference-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
/** A fake SDK whose clients count how often they are created and closed. */
function fakeSdk() {
  const clients: { model: string; disposed: boolean }[] = [];
  const sdk = {
    listModels: () => [{ id: 'a', runtime: { name: 'mflux' } }, { id: 'b', runtime: { name: 'mflux' } }],
    openModel: async (id: string) => ({ status: 'present', model: { id } }),
    inspectNativeEngine: async () => ({ status: 'ready' }),
    createImageClient: (options: { model: { id: string } }) => {
      const client = { model: options.model.id, disposed: false };
      clients.push(client);
      return { generate: async () => ({ image: { path: '/out.png' } }), edit: async () => ({}), dispose: vi.fn(async () => { client.disposed = true; }) };
    },
  } as unknown as InferenceSdk;
  return { sdk, clients };
}
it('reuses a warm client for the same model, never keeps more clients than the limit and closes them on release', async () => {
  const sessions = new Sessions(root); const session = await sessions.create();
  const settings: Settings = { version: 1, profile: { version: 1 }, registrations: {} };
  const { sdk, clients } = fakeSdk(); const run = inference(() => sessions, () => settings, sdk);
  const events = { signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {} };
  const attempt = (modelId: string) => run(session.id, { id: crypto.randomUUID(), modelId, seed: 1, draft: session.draft, status: 'running', created: '' }, events);
  await attempt('a'); await attempt('a');
  expect(clients).toHaveLength(1);
  await attempt('b');
  expect(clients.map(client => [client.model, client.disposed])).toEqual([['a', true], ['b', false]]);
  settings.concurrency = 2;
  await Promise.all([attempt('a'), attempt('b')]);
  expect(clients.filter(client => !client.disposed)).toHaveLength(2);
  await run.release!(); expect(clients.every(client => client.disposed)).toBe(true);
});
