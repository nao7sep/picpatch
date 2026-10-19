import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../', import.meta.url));
function imports(source: string): string[] {
  const result: string[] = []; const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  function walk(value: any) { if (!value || typeof value !== 'object') return; if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(value.type) && typeof value.source?.value === 'string') result.push(value.source.value); for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); }
  walk(ast); return result;
}
const forbidden = (file: string, specifier: string) => specifier.startsWith('picpatchsdk/') && specifier !== 'picpatchsdk/types' || specifier.startsWith('.') && relative(join(root, 'sdk'), resolve(dirname(file), specifier)).split('/')[0] !== '..';
async function files(directory: string): Promise<string[]> { const found = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await files(path)); else if (path.endsWith('.ts')) found.push(path); } return found; }
it('consumes only the SDK public package entries, with a planted violation proving the guard', async () => {
  const violations = [];
  for (const file of await files(join(root, 'src'))) for (const specifier of imports(await readFile(file, 'utf8'))) if (forbidden(file, specifier)) violations.push(`${file}: ${specifier}`);
  expect(violations).toEqual([]); expect(forbidden(join(root, 'src', 'bad.ts'), '../sdk/src/client.ts')).toBe(true); expect(imports("import x from 'picpatchsdk/src/client.ts'").some(s => forbidden('', s))).toBe(true);
});
it('keeps Node and browser global types separated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-type-boundary-'));
  try {
    for (const [environment, expression] of [['node','document.title'], ['web','process.env']] as const) {
      const fixture = join(directory, `${environment}.ts`); await writeFile(fixture, `${expression};\nexport {};\n`);
      const config = join(directory, `${environment}.json`); await writeFile(config, JSON.stringify({ extends: join(root, `tsconfig.${environment}.json`), compilerOptions: { typeRoots: [join(root, 'node_modules', '@types')] }, include: [], files: [fixture] }));
      let diagnostic = '';
      try { await promisify(execFile)(join(root, 'node_modules', '.bin', 'tsc'), ['-p', config]); } catch (error) { diagnostic = (error as { stdout?: string }).stdout ?? ''; }
      expect(diagnostic).toContain(`Cannot find name '${environment === 'node' ? 'document' : 'process'}'`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
