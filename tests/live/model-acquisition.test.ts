import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { listModels, prepareModel, verifyModel, type CatalogModel, type DiagnosticEvent } from '../../src/index.ts';
import * as catalog from '../../src/models/catalog.ts';

it.each([false, true])('acquires a tiny HTTP fixture through the production streaming boundary (cancel=%s)', async cancel => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-acquire-'));
  const controller = new AbortController();
  const bytes = Buffer.from('local fixture bytes');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': bytes.length });
    if (cancel) { response.write(bytes.subarray(0, 1)); controller.abort(); }
    else response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server address unavailable.');
  // Route the outbound request locally without adding a public insecure URL override.
  const transport = globalThis.fetch;
  const fetcher: typeof fetch = (_url, options) => transport(`http://127.0.0.1:${address.port}/fixture`, options);
  const entry: CatalogModel = { ...listModels()[0]!, id: 'fixture', manifest: {
    version: 1 as const, model: 'fixture', source: { repository: 'fixture', revision: 'b'.repeat(40) },
    components: [{ path: 'weights.safetensors', role: 'weights' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  } };
  // Fixture catalog pins replace real weights; all public orchestration remains intact.
  vi.spyOn(catalog, 'catalogModel').mockReturnValue(entry);
  vi.stubGlobal('fetch', vi.fn(fetcher));
  vi.stubEnv('PICPATCH_DATA_DIR', directory);
  vi.stubEnv('PICPATCH_MODELS_DIR', join(directory, 'models'));
  const events: DiagnosticEvent[] = [];
  try {
    await expect(prepareModel(entry.id)).rejects.toMatchObject({ code: 'MODEL_IO' });
    expect(fetch).not.toHaveBeenCalled();
    const preparation = prepareModel(entry.id, { download: true, signal: controller.signal, onDiagnostic: event => events.push(event) });
    if (cancel) await expect(preparation).rejects.toMatchObject({ code: 'CANCELLED' });
    else {
      const prepared = await preparation;
      expect(prepared).toMatchObject({ origin: 'download', integrity: 'matches-manifest' });
      expect((await verifyModel(prepared.model.directory, prepared.model.manifest)).status).toBe('matches-manifest');
      expect((await prepareModel(entry.id)).origin).toBe('cache');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(events.at(-1)?.stage).toBe(cancel ? 'cancelled' : 'succeeded');
    expect(new Set(events.map(event => event.operationId)).size).toBe(1);
    expect(await readdir(join(directory, 'models', 'fixture'))).toEqual(cancel ? [] : ['b'.repeat(40)]);
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(server.listening).toBe(false);
    await rm(directory, { recursive: true, force: true });
  }
});
