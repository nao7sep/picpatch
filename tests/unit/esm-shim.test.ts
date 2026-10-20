import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';

// electron-vite gives every main-process bundle its own __dirname and __filename, so a bundled module that declares
// either makes the bundle a syntax error at load: the app fails to start while its tests, which never load the
// bundle, still pass. The main process, the shared modules and the SDK it bundles use import.meta.dirname or a
// differently named constant instead.
const SHIMMED = new Set(['__dirname', '__filename']);
const root = new URL('../../', import.meta.url).pathname;

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

async function declaredShims(file: string): Promise<string[]> {
  const ast = parse(await readFile(file, 'utf8'), { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'] });
  const found: string[] = [];
  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') for (const declarator of declaration.declarations) if (declarator.id.type === 'Identifier' && SHIMMED.has(declarator.id.name)) found.push(declarator.id.name);
    if ((declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') && declaration.id && SHIMMED.has(declaration.id.name)) found.push(declaration.id.name);
  }
  return found;
}

it('keeps bundled main-process modules free of their own __dirname or __filename', async () => {
  const offenders: string[] = [];
  // The SDK is found by its package name, as any consumer finds it; its entry sits at the root of its sources.
  const sdk = dirname(fileURLToPath(import.meta.resolve('picpatchsdk')));
  expect(await readdir(sdk)).toContain('index.ts');
  for (const directory of [join(root, 'src/main'), join(root, 'src/shared'), sdk]) for (const file of await sources(directory)) for (const name of await declaredShims(file)) offenders.push(`${relative(root, file)}: ${name}`);
  expect(offenders).toEqual([]);
});

it('finds such a declaration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-esm-shim-'));
  try {
    const probe = join(directory, 'probe.ts');
    await writeFile(probe, 'import { dirname } from "node:path";\nexport const __dirname = dirname("/x/y");\nfunction __filename() {}\n');
    expect(await declaredShims(probe)).toEqual(['__dirname', '__filename']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
