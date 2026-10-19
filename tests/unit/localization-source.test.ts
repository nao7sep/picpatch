import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { expect, it } from 'vitest';
import { catalogues } from '../../src/shared/i18n/index.ts';
function walk(value: any, visit: (node: any) => void) { if (!value || typeof value !== 'object') return; if (value.type) visit(value); for (const [key, child] of Object.entries(value)) if (key !== 'loc') { if (Array.isArray(child)) child.forEach(item => walk(item, visit)); else walk(child, visit); } }
it('keeps readable source text catalogued and rejects missing message keys', async () => {
  const en = await catalogues.en();
  const files = [...(await readdir('src/renderer')).filter(name => name.endsWith('.ts')).map(name => join('src/renderer',name)), 'src/desktop/main.ts','src/shared/admission.ts'];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const ast = parse(source, { sourceType:'module', plugins:['typescript'] });
    walk(ast, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['t','message'].includes(node.callee.name) && node.arguments[0]?.type === 'StringLiteral') expect(Object.hasOwn(en,node.arguments[0].value), `${file}:${node.arguments[0].value}`).toBe(true);
      if (node.type === 'NewExpression' && node.callee.name === 'UiError' && node.arguments[0]?.type === 'StringLiteral') expect(Object.hasOwn(en,node.arguments[0].value), `${file}:${node.arguments[0].value}`).toBe(true);
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && ['textContent','placeholder','alt','title'].includes(node.left.property.name) && node.right.type === 'StringLiteral') expect(node.right.value, `${file}:${node.start}`).not.toMatch(/[a-z]/i);
      if (node.type === 'ObjectProperty' && ['label','title','message','detail','empty'].includes(node.key.name) && node.value.type === 'StringLiteral') expect(['PicPatch',''].includes(node.value.value), `${file}:${node.value.value}`).toBe(true);
    });
  }
  const html = await readFile('src/renderer/index.html','utf8');
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) expect(Object.hasOwn(en,match[1]!),match[1]).toBe(true);
  expect(html.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<title>PicPatch<\/title>/g,'')).not.toMatch(/>[\s]*[A-Za-z][^<]*</);
});
