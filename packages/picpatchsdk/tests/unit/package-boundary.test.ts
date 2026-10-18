import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';
import manifest from '../../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../', import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
function violation(file: string, specifier: string): boolean {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier);
    return relative(root, target).startsWith('..') || !['.ts', '.json'].includes(extname(target));
  }
  if (isAbsolute(specifier)) return true;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
  return !builtins.has(specifier) && !(name in manifest.dependencies);
}
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]))).flat();
}
it('keeps every runtime import inside the package or its declared dependencies', async () => {
  const failures: string[] = [];
  for (const file of (await files(resolve(root, 'src'))).filter(file => file.endsWith('.ts'))) {
    const source = parse(await readFile(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'importAttributes'] });
    function visit(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const value = node as Record<string, unknown>;
      const specifier = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(value.type)) ? value.source : undefined;
      if (specifier && typeof specifier === 'object' && 'value' in specifier && typeof specifier.value === 'string' && violation(file, specifier.value)) failures.push(`${relative(root, file)}: ${specifier.value}`);
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === 'object') visit(child);
      }
    }
    visit(source);
  }
  expect(failures).toEqual([]);
});
it('detects outside imports, undeclared dependencies and extensionless source imports', () => {
  const file = resolve(root, 'src/index.ts');
  for (const specifier of ['../../app.ts', 'electron', './client', '/outside.ts']) expect(violation(file, specifier)).toBe(true);
  for (const specifier of ['./client.ts', 'node:fs', 'sharp']) expect(violation(file, specifier)).toBe(false);
});
