import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { VERSION } from '../../src/index.ts';

it('exports the package version from its single source', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(VERSION).toBe(manifest.version);
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/);
});
