import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import app from '../../package.json' with { type: 'json' };

// The app bundles the SDK, so its package must carry every runtime dependency the SDK loads, or the packaged app fails to start.
it('declares every runtime dependency the SDK loads, with the same range', async () => {
  const sdk = JSON.parse(await readFile(fileURLToPath(import.meta.resolve('picpatchsdk/package.json')), 'utf8')) as { dependencies: Record<string, string> };
  const declared = app.dependencies as Record<string, string>;
  expect(Object.keys(sdk.dependencies).length).toBeGreaterThan(0);
  for (const [name, range] of Object.entries(sdk.dependencies)) expect(declared[name], name).toBe(range);
});
