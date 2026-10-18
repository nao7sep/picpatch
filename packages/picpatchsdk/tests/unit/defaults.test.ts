import { expect, it, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditor } from '../../src/index.ts';
import { resolveEditRequest, validateDefaults } from '../../src/defaults.ts';
import { defaultPythonExecutable } from '../../src/backends/mflux/launch.ts';

afterEach(() => vi.unstubAllEnvs());
it('inherits the model and settings while per-edit options take precedence', () => {
  const defaults = { size: { width: 512, height: 512 }, seed: 1, outputDirectory: '/outputs' };
  const resolved = resolveEditRequest({ instruction: 'Edit', sourceImage: '/source/input.jpg', seed: 0 }, defaults, 'selected');
  expect(resolved).toMatchObject({ model: 'selected', seed: 0, size: defaults.size });
  expect(resolved.outputPath).toMatch(/^\/outputs\/edit-[a-f0-9-]+\.png$/);
  expect(resolveEditRequest({ instruction: 'Edit', sourceImage: '/source.png', size: { width: 256, height: 256 }, outputPath: '/chosen.png' }, defaults, 'selected')).toMatchObject({ outputPath: '/chosen.png', size: { width: 256, height: 256 } });
});
it('uses unique source siblings, while reference-only edits require a destination', () => {
  const request = { instruction: 'Edit', sourceImage: '/authored/source.jpg' };
  const a = resolveEditRequest(request, {}, 'selected'); const b = resolveEditRequest(request, {}, 'selected');
  expect(a.outputPath).toMatch(/^\/authored\/edit-/); expect(a.outputPath).not.toBe(b.outputPath);
  const references: [import('../../src/types.ts').ReferenceGroup] = [{ id: 'style', role: 'style' as const, images: ['/reference.png'] as [string] }];
  expect(() => resolveEditRequest({ instruction: 'Edit', references }, {}, 'selected')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(resolveEditRequest({ instruction: 'Edit', references, outputDirectory: '/destination' }, {}, 'selected').outputPath).toMatch(/^\/destination\/edit-/);
});
it('rejects conflicting model/destination settings and invalid defaults', () => {
  expect(() => resolveEditRequest({ instruction: 'Edit', model: 'different', sourceImage: '/in.png' }, {}, 'selected')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  expect(() => resolveEditRequest({ instruction: 'Edit', sourceImage: '/in.png', outputPath: '/out.png', outputDirectory: '/elsewhere' }, {}, 'selected')).toThrow();
  for (const defaults of [{ seed: -1 }, { size: { width: 0, height: 1 } }, { outputDirectory: 'relative' }, { unknown: true }, null]) {
    expect(() => validateDefaults(defaults as never)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  }
});
it('snapshots session defaults and keeps absent inference settings absent', () => {
  const input = { size: { width: 256, height: 256 } };
  const defaults = validateDefaults(input); input.size.width = 32;
  expect(defaults.size?.width).toBe(256);
  const resolved = resolveEditRequest({ instruction: 'Edit', sourceImage: '/in.png' }, {}, 'selected');
  expect(resolved).not.toHaveProperty('size'); expect(resolved).not.toHaveProperty('seed');
});
it('resolves uv project environments deterministically without system Python selection', async () => {
  vi.stubEnv('UV_PROJECT_ENVIRONMENT', undefined);
  const worker = fileURLToPath(new URL('../../runtimes/mflux/', import.meta.url));
  const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  expect(defaultPythonExecutable()).toBe(join(worker, '.venv', executable));
  vi.stubEnv('UV_PROJECT_ENVIRONMENT', 'custom-env');
  expect(defaultPythonExecutable()).toBe(join(worker, 'custom-env', executable));
  const editor = createEditor(); await editor.dispose();
});
