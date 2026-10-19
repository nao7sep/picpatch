import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Bundle runtime source and locks, never development environments or model caches. */
export async function copyRuntimeResources(source, destination) {
  for (const runtime of await readdir(source, { withFileTypes: true })) {
    if (!runtime.isDirectory() || runtime.name.startsWith('.')) continue;
    const directory = join(source, runtime.name), target = join(destination, runtime.name);
    await mkdir(target, { recursive: true });
    for (const item of await readdir(directory)) {
      if (!['src', 'pyproject.toml', 'uv.lock', 'engine_probe.py', 'THIRD_PARTY_NOTICES'].includes(item)) continue;
      await cp(join(directory, item), join(target, item), { recursive: true,
        filter: path => !path.split(/[\\/]/).includes('__pycache__') && !path.endsWith('.pyc') });
    }
  }
}
