import { expect, it } from 'vitest';
import { listModels } from 'picpatchsdk';
import { pythonRuntime } from '../../src/app/engines.ts';

it('selects the managed Python dependencies for every catalog runtime', async () => {
  const models = await listModels();
  for (const model of models) {
    expect(pythonRuntime(models, model.id)).toBe(model.runtime.name === 'stable-diffusion.cpp' ? 'mflux' : model.runtime.name);
  }
  expect(pythonRuntime(models)).toBe('mflux');
});
