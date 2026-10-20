import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../', import.meta.url));
// JSX only in .tsx, as TypeScript reads it: in a .ts file `<T>(x) => x` is a generic arrow function.
const parseSource = (source: string, file: string) => parse(source, { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'] });
function imports(source: string, file = 'source.tsx'): string[] {
  const result: string[] = []; const ast = parseSource(source, file);
  function walk(value: any) { if (!value || typeof value !== 'object') return; if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(value.type) && typeof value.source?.value === 'string') result.push(value.source.value); for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); }
  walk(ast); return result;
}
const forbidden = (file: string, specifier: string) => specifier.startsWith('picpatchsdk/') && specifier !== 'picpatchsdk/types' || specifier.startsWith('.') && relative(join(root, 'sdk'), resolve(dirname(file), specifier)).split(sep)[0] !== '..';
/** Every string in a file that names a path into the SDK's folder, such as a hard-coded cache or helper path. */
function sdkPaths(source: string, file = 'source.tsx'): string[] {
  const found: string[] = []; const ast = parseSource(source, file);
  function walk(value: any) {
    if (!value || typeof value !== 'object') return;
    const text = value.type === 'StringLiteral' ? value.value : value.type === 'TemplateElement' ? value.value.raw : undefined;
    if (typeof text === 'string' && /(^|[\\/])sdk[\\/]/.test(text)) found.push(text);
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child);
  }
  walk(ast); return found;
}
async function files(directory: string): Promise<string[]> { const found = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await files(path)); else if (/\.tsx?$/.test(path)) found.push(path); } return found; }
it('consumes only the SDK public package entries, in the app and its tests, with planted violations proving the guard', async () => {
  const violations = [];
  // The app's tests are consumers too: they use the SDK by name and never a path into its package, so it can move to a repository of its own unchanged.
  for (const file of [...await files(join(root, 'src')), ...await files(join(root, 'tests'))]) {
    const source = await readFile(file, 'utf8');
    for (const specifier of imports(source, file)) if (forbidden(file, specifier)) violations.push(`${relative(root, file)}: ${specifier}`);
    if (file !== fileURLToPath(import.meta.url)) for (const path of sdkPaths(source, file)) violations.push(`${relative(root, file)}: ${path}`);
  }
  expect(violations).toEqual([]);
  expect(forbidden(join(root, 'tests', 'bad.ts'), '../sdk/tests/helpers/live-cache.ts')).toBe(true);
  expect(imports("import x from 'picpatchsdk/src/client.ts'").some(s => forbidden('', s))).toBe(true);
  expect(sdkPaths("const cache = resolve('sdk/node_modules/.cache/picpatch-live');")).toHaveLength(1);
  expect(sdkPaths('const helper = `${root}/sdk/tests/helpers`;')).toHaveLength(1);
  expect(sdkPaths("import.meta.resolve('picpatchsdk/package.json');")).toEqual([]);
});
it('keeps Node and browser global types separated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-type-boundary-'));
  try {
    for (const [environment, expression] of [['node','document.title'], ['web','process.env']] as const) {
      const fixture = join(directory, `${environment}.ts`); await writeFile(fixture, `${expression};\nexport {};\n`);
      const config = join(directory, `${environment}.json`); await writeFile(config, JSON.stringify({ extends: join(root, `tsconfig.${environment}.json`), compilerOptions: { typeRoots: [join(root, 'node_modules', '@types')] }, include: [], files: [fixture] }));
      let diagnostic = '';
      // Run the compiler through Node: node_modules/.bin/tsc is a shell script Windows cannot start.
      try { await promisify(execFile)(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', config]); } catch (error) { diagnostic = (error as { stdout?: string }).stdout ?? ''; }
      expect(diagnostic).toContain(`Cannot find name '${environment === 'node' ? 'document' : 'process'}'`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('keeps Electron in the shell and Node out of the renderer', async () => {
  const violations = [];
  for (const [directory, banned] of [['src/main/core', /^electron$/], ['src/shared', /^(electron|node:)/], ['src/renderer', /^(electron|node:)/]] as const)
    for (const file of await files(join(root, directory))) for (const specifier of imports(await readFile(file, 'utf8'), file)) if (banned.test(specifier)) violations.push(`${relative(root, file)}: ${specifier}`);
  expect(violations).toEqual([]);
});
