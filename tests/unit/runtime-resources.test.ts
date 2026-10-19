import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const { copyRuntimeResources } = await import(new URL('../../scripts/runtime-resources.mjs', import.meta.url).href) as {
  copyRuntimeResources(source: string, destination: string): Promise<void>;
};

it('packages every runtime source and attribution without installed environments or caches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-runtime-package-'));
  try {
    const source = join(directory, 'source'), destination = join(directory, 'bundle');
    for (const relative of ['common/src/core/entry.py', 'dreamo/src/worker/adapter.py', 'dreamo/THIRD_PARTY_NOTICES', 'dreamo/uv.lock', 'mflux/engine_probe.py', 'dreamo/.venv/bin/python', 'dreamo/src/worker/__pycache__/adapter.pyc']) {
      const path = join(source, relative); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, relative);
    }
    await copyRuntimeResources(source, destination);
    expect(await readFile(join(destination, 'common/src/core/entry.py'), 'utf8')).toBe('common/src/core/entry.py');
    expect(await readFile(join(destination, 'dreamo/THIRD_PARTY_NOTICES'), 'utf8')).toBe('dreamo/THIRD_PARTY_NOTICES');
    await access(join(destination, 'dreamo/src/worker/adapter.py'));
    await access(join(destination, 'mflux/engine_probe.py'));
    await expect(access(join(destination, 'dreamo/.venv'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(destination, 'dreamo/src/worker/__pycache__'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
