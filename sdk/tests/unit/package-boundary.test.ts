import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
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
  const source = parse(text, { sourceType: 'module', createImportExpressions: true, plugins: ['typescript'] });
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

function ambientReads(text: string, file: string): string[] {
  const source = parse(text, { sourceType: 'module', plugins: ['typescript'] });
  const failures: string[] = [];
  const processes = new Set(['process']); const operatingSystems = new Set<string>();
  const prohibited = new Set(['env', 'cwd', 'stdout', 'stderr', 'stdin']);
  const name = (node: any): string | undefined => node?.name ?? node?.value;
  // Only platform.ts reads the environment, and only for Windows' own system and temporary folders.
  const osLocation = (member: string) => member === 'env' && file === 'src/platform.ts';
  for (const entry of source.program.body) {
    if (entry.type !== 'ImportDeclaration') continue;
    if (['node:console', 'console'].includes(entry.source.value)) failures.push('console');
    for (const specifier of entry.specifiers) {
      const member = specifier.type === 'ImportSpecifier' ? name(specifier.imported) : undefined;
      if (['node:process', 'process'].includes(entry.source.value)) {
        if (member && prohibited.has(member) && !osLocation(member)) failures.push(member);
        else if (!member) processes.add(specifier.local.name);
      }
      if (['node:os', 'os'].includes(entry.source.value)) {
        if (member === 'homedir' && file !== 'src/paths.ts') failures.push('homedir');
        else if (!member) operatingSystems.add(specifier.local.name);
      }
    }
  }
  function visit(value: any): void {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'MemberExpression' || value.type === 'OptionalMemberExpression') {
      if (processes.has(name(value.object)!) && prohibited.has(name(value.property)!) && !osLocation(name(value.property)!)) failures.push(name(value.property)!);
      if (name(value.object) === 'console') failures.push('console');
      if (operatingSystems.has(name(value.object)!) && name(value.property) === 'homedir' && file !== 'src/paths.ts') failures.push('homedir');
    }
    if (value.type === 'VariableDeclarator' && value.id?.type === 'ObjectPattern' && processes.has(name(value.init)!)) {
      for (const property of value.id.properties) if (prohibited.has(name(property.key)!)) failures.push(name(property.key)!);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  }
  visit(source);
  return failures;
}
it('keeps ambient caller state and standard streams outside SDK source', async () => {
  const failures: string[] = [];
  for (const file of (await files(resolve(root, 'src'))).filter(file => file.endsWith('.ts'))) {
    const name = relative(root, file).split(sep).join('/');
    failures.push(...ambientReads(await readFile(file, 'utf8'), name).map(reason => `${name}: ${reason}`));
  }
  expect(failures).toEqual([]);
});
it('detects planted ambient reads, import aliases and stream writes', () => {
  expect(ambientReads(`import p from 'node:process'; import {env as settings} from 'node:process'; import os from 'node:os'; p['env']; const {cwd} = process; process.stderr.write('x'); console.log('x'); os.homedir();`, 'src/client.ts')).toEqual(['env', 'env', 'cwd', 'stderr', 'console', 'homedir']);
  expect(ambientReads(`import {homedir} from 'node:os'; homedir();`, 'src/paths.ts')).toEqual([]);
  expect(ambientReads(`process.env.SystemRoot;`, 'src/platform.ts')).toEqual([]); expect(ambientReads(`process.env.SystemRoot;`, 'src/client.ts')).toEqual(['env']);
});
