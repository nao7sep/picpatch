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

it('keeps readable interface text catalogued and every message key defined', async () => {
  const en = await catalogues.en();
  const problems: string[] = [];
  for (const file of [...await sources('src/renderer'), 'src/desktop/main.ts', 'src/shared/admission.ts']) {
    const source = await readFile(file, 'utf8');
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
  }
  expect(problems).toEqual([]);
});

it('catches a planted hard-coded caption', () => {
  const ast = parse('const a = <button title="Save">Save</button>;', { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const found: string[] = [];
  walk(ast, node => { if (node.type === 'JSXText' && /[a-z]/i.test(node.value)) found.push(node.value); if (node.type === 'JSXAttribute' && node.name.name === 'title') found.push(node.value.value); });
  expect(found).toEqual(['Save', 'Save']);
});
