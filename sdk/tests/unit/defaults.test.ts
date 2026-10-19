import { expect, it, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageClient } from '../../src/index.ts';
import { resolveEditRequest, validateDefaults } from '../../src/defaults.ts';

afterEach(() => vi.unstubAllEnvs());
it('inherits the model and settings while per-edit options take precedence', () => {
  const defaults = { size: { width: 512, height: 512 }, seed: 1, outputDirectory: '/outputs' };
  const resolved = resolveEditRequest({ instruction: 'Edit', sourceImage: '/source/input.jpg', seed: 0 }, defaults, 'selected');
  expect(resolved).toMatchObject({ model: 'selected', seed: 0, size: defaults.size });
  expect(resolved.outputPath).toMatch(/^\/outputs\/edit-[a-f0-9-]+\.png$/);
  expect(resolveEditRequest({ instruction: 'Edit', sourceImage: '/source.png', size: { width: 256, height: 256 }, outputPath: '/chosen.png' }, defaults, 'selected')).toMatchObject({ outputPath: '/chosen.png', size: { width: 256, height: 256 } });
});
it('uses unique names only inside an explicit destination', () => {
  const request = { instruction: 'Edit', sourceImage: '/authored/source.jpg', outputDirectory: '/destination' };
  const a = resolveEditRequest(request, {}, 'selected'); const b = resolveEditRequest(request, {}, 'selected');
  expect(a.outputPath).toMatch(/^\/destination\/edit-/); expect(a.outputPath).not.toBe(b.outputPath);
  const references: [import('../../src/types.ts').ReferenceGroup] = [{ id: 'style', role: 'style' as const, images: ['/reference.png'] as [string] }];
  expect(() => resolveEditRequest({ instruction: 'Edit', references }, {}, 'selected')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  expect(resolveEditRequest({ instruction: 'Edit', references, outputDirectory: '/destination' }, {}, 'selected').outputPath).toMatch(/^\/destination\/edit-/);
});
it('rejects conflicting model/destination settings and invalid defaults', () => {
  expect(() => resolveEditRequest({ instruction: 'Edit', model: 'different', sourceImage: '/in.png', outputDirectory: '/outputs' }, {}, 'selected')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  expect(() => resolveEditRequest({ instruction: 'Edit', sourceImage: '/in.png', outputPath: '/out.png', outputDirectory: '/elsewhere' }, {}, 'selected')).toThrow();
  for (const defaults of [{ seed: -1 }, { size: { width: 0, height: 1 } }, { outputDirectory: 'relative' }, { unknown: true }, null]) {
    expect(() => validateDefaults(defaults as never)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  }
});
it('snapshots session defaults and keeps absent inference settings absent', () => {
  const input = { size: { width: 256, height: 256 } };
  const defaults = validateDefaults(input); input.size.width = 32;
  expect(defaults.size?.width).toBe(256);
  const resolved = resolveEditRequest({ instruction: 'Edit', sourceImage: '/in.png', outputDirectory: '/outputs' }, {}, 'selected');
  expect(resolved).not.toHaveProperty('size'); expect(resolved).not.toHaveProperty('seed');
});
it('does not inspect ambient interpreter settings when constructing an editor', async () => {
  vi.stubEnv('UV_PROJECT_ENVIRONMENT', '/not-an-engine');
  const editor = createImageClient({ engineDirectory: '/explicit/engine' }); await editor.dispose();
});
