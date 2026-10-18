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
function imports(file: string, text: string): string[] {
  const failures: string[] = [];
  const source = parse(text, { sourceType: 'module', createImportExpressions: true, plugins: ['typescript', 'importAttributes'] });
  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    const specifier = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(String(value.type)) ? value.source : undefined;
    if (specifier && typeof specifier === 'object' && 'value' in specifier && typeof specifier.value === 'string' && violation(file, specifier.value)) failures.push(specifier.value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(source);
  return failures;
}
it('keeps every runtime import inside the package or its declared dependencies', async () => {
  const failures: string[] = [];
  for (const file of (await files(resolve(root, 'src'))).filter(file => file.endsWith('.ts'))) {
    failures.push(...imports(file, await readFile(file, 'utf8')).map(specifier => `${relative(root, file)}: ${specifier}`));
  }
  expect(failures).toEqual([]);
});
it('detects planted static imports, re-exports and dynamic imports across the boundary', () => {
  const file = resolve(root, 'src/index.ts');
  expect(imports(file, `
    import '../../app.ts';
    export * from 'electron';
    export { value } from './client';
    await import('/outside.ts');
    import './client.ts';
    import 'node:fs';
    import 'sharp';
  `)).toEqual(['../../app.ts', 'electron', './client', '/outside.ts']);
});
