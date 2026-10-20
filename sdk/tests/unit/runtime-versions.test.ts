import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { pythonVersion, runtimeVersions } from '../../src/runtime/engine/versions.ts';
import dreamo from '../../runtimes/dreamo/src/picpatch_dreamo/models.json' with { type: 'json' };

const pyproject = (runtime: string) => readFile(new URL(`../../runtimes/${runtime}/pyproject.toml`, import.meta.url), 'utf8');

it('states the Python every runtime project requires', async () => {
  const [major, minor] = pythonVersion.split('.');
  for (const runtime of ['mflux', 'dreamo', 'diffusers']) expect(await pyproject(runtime), runtime).toContain(`requires-python = ">=${major}.${minor},<${major}.${Number(minor) + 1}"`);
});
it('states the runtime versions the projects pin', async () => {
  expect(await pyproject('mflux')).toMatch(new RegExp(`"mflux==${runtimeVersions.mflux.replaceAll('.', '\\.')}"`));
  expect(await pyproject('diffusers')).toMatch(new RegExp(`"diffusers==${runtimeVersions.diffusers.replaceAll('.', '\\.')}"`));
  // DreamO is vendored source, released as the version its model selection names.
  expect(dreamo.map(model => model.id)).toContain(`flux1-dreamo-v${runtimeVersions.dreamo}`);
});
