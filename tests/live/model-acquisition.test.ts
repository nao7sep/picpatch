import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { listModels, type CatalogModel } from '../../src/models/catalog.ts';
import { prepareCatalogModel } from '../../src/models/preparation.ts';

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
  // Only the outbound transport is substituted: no public insecure URL override.
  const fetcher: typeof fetch = (_url, options) => fetch(`http://127.0.0.1:${address.port}/fixture`, options);
  const entry: CatalogModel = { ...listModels()[0]!, id: 'fixture', manifest: {
    version: 1 as const, model: 'fixture', source: { repository: 'fixture', revision: 'b'.repeat(40) },
    components: [{ path: 'weights.safetensors', role: 'weights' as const, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  } };
  try {
    const preparation = prepareCatalogModel(entry, { download: true, signal: controller.signal, storage: { dataDirectory: directory, modelsDirectory: join(directory, 'models') } }, fetcher);
    if (cancel) await expect(preparation).rejects.toMatchObject({ code: 'CANCELLED' });
    else expect(await preparation).toMatchObject({ origin: 'download', integrity: 'matches-manifest' });
    expect(await readdir(join(directory, 'models', 'fixture'))).toEqual(cancel ? [] : ['b'.repeat(40)]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(server.listening).toBe(false);
    await rm(directory, { recursive: true, force: true });
  }
});
