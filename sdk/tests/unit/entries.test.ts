import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

// Every entry runs from source on plain Node, as a consumer or a script loads it: no build, loader or compiler.
it.each(Object.keys(pkg.exports).filter(entry => entry !== './package.json'))('loads %s under plain Node', async entry => {
  const specifier = entry === '.' ? pkg.name : `${pkg.name}/${entry.slice(2)}`;
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(specifier)}); console.log(Object.keys(m).sort().join(','));`], { cwd: root, timeout: 30_000 });
  expect(stderr).toBe('');
  expect(stdout.trim().length).toBeGreaterThan(0);
});
it('the browser entry carries the admission check a window calls before submitting', async () => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `const m = await import('${pkg.name}/types'); console.log(typeof m.admissionIssues, m.refusalCodes.length > 0);`], { cwd: root, timeout: 30_000 });
  expect(stdout.trim()).toBe('function true');
});
