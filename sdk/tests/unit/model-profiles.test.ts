import { expect, it } from 'vitest';
import { listModels } from '../../src/index.ts';

it('gives every selection a profile whose facts agree with its catalog data', () => {
  for (const model of listModels()) {
    expect(model.profile.name, model.id).toMatch(/\S/);
    expect(model.profile.parameters, model.id).toBeGreaterThan(0);
    if (model.evidence === 'real-weights') expect(model.tested.length, model.id).toBeGreaterThan(0); else expect(model.tested, model.id).toEqual([]);
    if (model.acquisition === 'pinned') expect(model.profile.licence, model.id).toBe(/non-commercial/.test(model.license.id) ? 'non-commercial' : 'commercial');
  }
  // A pinned quantization and the caller's own files describe the same model.
  const pinned = listModels().find(model => model.id === 'flux2-klein-4b-4bit')!, own = listModels().find(model => model.id === 'flux2-klein-4b')!;
  expect(own.profile).toEqual(pinned.profile);
  expect(own.evidence).toBe('api');
});
