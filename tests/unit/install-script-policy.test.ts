import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type LockedPackage = { version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean };
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { allowScripts: Record<string, boolean> };
const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, LockedPackage> };

it('reviews install scripts by exact locked identity with registry provenance for every decision', () => {
  const scriptPackages = Object.entries(lock.packages).filter(([, entry]) => entry.hasInstallScript);
  expect(scriptPackages.length).toBeGreaterThan(0);
  const reviewed = new Set<string>();
  for (const [path, entry] of scriptPackages) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const identity = `${name}@${entry.version}`;
    expect(manifest.allowScripts, identity).toHaveProperty(identity);
    reviewed.add(identity);
    expect(typeof manifest.allowScripts[identity], identity).toBe('boolean');
    // npm derives a registry version from the resolved tarball URL; without it,
    // exact approvals fail to match and denials can cover other versions.
    const basename = name.slice(name.lastIndexOf('/') + 1);
    expect(entry.resolved, identity).toBe(`https://registry.npmjs.org/${name}/-/${basename}-${entry.version}.tgz`);
    if (manifest.allowScripts[identity]) expect(entry.integrity, identity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
  // Reject stale pins and broad approvals as well as unreviewed scripts.
  expect(Object.keys(manifest.allowScripts).sort()).toEqual([...reviewed].sort());
});
