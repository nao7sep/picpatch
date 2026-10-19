import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';
import { catalogues } from '../../src/shared/i18n/index.ts';

/** Text that is a name rather than interface copy, and so is never translated. */
const LITERALS = new Set(['PicPatch']);
const READABLE = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);

function walk(value: any, visit: (node: any, parent: any) => void, parent?: any) {
  if (!value || typeof value !== 'object') return;
  if (value.type) visit(value, parent);
  for (const [key, child] of Object.entries(value)) if (key !== 'loc') {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit, value)); else walk(child, visit, value);
  }
}
async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path)); else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Every catalogue and hard-coded-text problem in one source file. */
function problemsIn(source: string, file: string, en: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  walk(ast, (node, parent) => {
    const literal = (value: string) => /[a-z]/i.test(value) && !LITERALS.has(value.trim());
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['t', 'message', 'confirm'].includes(node.callee.name) && node.arguments[0]?.type === 'StringLiteral' && !Object.hasOwn(en, node.arguments[0].value)) problems.push(`${file}: missing key ${node.arguments[0].value}`);
    if (node.type === 'NewExpression' && node.callee.name === 'UiError' && node.arguments[0]?.type === 'StringLiteral' && !Object.hasOwn(en, node.arguments[0].value)) problems.push(`${file}: missing key ${node.arguments[0].value}`);
    if (node.type === 'JSXText' && literal(node.value)) problems.push(`${file}: text "${node.value.trim()}"`);
    if (node.type === 'StringLiteral' && parent?.type === 'JSXExpressionContainer' && literal(node.value)) problems.push(`${file}: text "${node.value}"`);
    if (node.type === 'JSXAttribute' && READABLE.has(node.name.name) && node.value?.type === 'StringLiteral' && literal(node.value.value)) problems.push(`${file}: ${node.name.name}="${node.value.value}"`);
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && ['textContent', 'placeholder', 'alt', 'title'].includes(node.left.property.name) && node.right.type === 'StringLiteral' && literal(node.right.value)) problems.push(`${file}: assigned "${node.right.value}"`);
  });
  return problems;
}

it('keeps readable interface text catalogued and every message key defined', async () => {
  const en = await catalogues.en();
  const problems: string[] = [];
  for (const file of [...await sources('src/renderer'), ...await sources('src/main'), ...await sources('src/shared')]) problems.push(...problemsIn(await readFile(file, 'utf8'), file, en));
  expect(problems).toEqual([]);
});

it('fails the real detector on planted hard-coded captions and unknown keys', async () => {
  const en = await catalogues.en();
  const planted = problemsIn("const a = <button title=\"Save\" aria-label={'Close'}>Save {'now'}</button>; t('ui.not_a_key');", 'planted.tsx', en);
  expect(planted.sort()).toEqual(['planted.tsx: missing key ui.not_a_key', 'planted.tsx: text "Close"', 'planted.tsx: text "Save"', 'planted.tsx: text "now"', 'planted.tsx: title="Save"']);
});
