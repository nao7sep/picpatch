import { expect, it } from 'vitest';
import cases from '../fixtures/sampling-contract.json' with { type: 'json' };
import { listModels, validateEditRequest, validateGenerateRequest } from '../../src/index.ts';
import { resolveParameters } from '../../src/parameters.ts';
import { resolveEditRequest, resolveGenerateRequest, validateDefaults } from '../../src/defaults.ts';

it.each(cases)('resolves or rejects $variant parameters $parameters', example => {
  const capabilities = listModels().find(model => model.id === example.variant)!.capabilities;
  const run = () => resolveParameters(example.parameters, capabilities);
  if (example.invalid) expect(run).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  else expect(run()).toEqual(example.effective);
});

it('publishes independent capabilities for every selectable model', () => {
  const models = listModels();
  for (const model of models) {
    expect(model.capabilities.model).toBe(model.id);
    expect(model.capabilities.parameters?.steps?.minimum).toBeGreaterThanOrEqual(1);
  }
  models[0]!.capabilities.parameters!.steps!.default = 999;
  expect(listModels()[0]!.capabilities.parameters!.steps!.default).toBe(4);
});

it('merges individual controls with request over session over model precedence for both verbs', () => {
  const input = { parameters: { steps: 8, guidance: 3 }, outputDirectory: '/outputs' };
  const defaults = validateDefaults(input);
  input.parameters.steps = 999;
  const edit = resolveEditRequest({ instruction: 'Blue', sourceImage: '/in.png', parameters: { steps: 2 } }, defaults, 'flux2-klein-4b');
  const generate = resolveGenerateRequest({ prompt: 'Blue', parameters: { steps: 2 } }, defaults, 'flux2-klein-4b');
  for (const request of [edit, generate]) {
    expect(request.parameters).toEqual({ steps: 2, guidance: 3 });
    expect(resolveParameters(request.parameters, listModels()[0]!.capabilities)).toEqual({ steps: 2, guidance: 3, scheduler: 'flow_match_euler_discrete' });
  }
});

it('rejects malformed controls and unsupported combinations through both public validators', () => {
  const base = { model: 'qwen-image-2.1', outputPath: '/out.png' };
  const caps = listModels().find(m => m.id === base.model)!.capabilities;
  for (const parameters of [null, [], { steps: 0 }, { steps: 1.5 }, { guidance: NaN }, { guidance: Infinity }, { unknown: 1 }, { negativePrompt: 1 }]) {
    expect(() => validateGenerateRequest({ ...base, prompt: 'Blue', parameters })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => validateEditRequest({ ...base, instruction: 'Blue', sourceImage: '/in.png', parameters })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => resolveGenerateRequest({ prompt: 'Blue', parameters } as never, { outputDirectory: '/out' }, base.model)).toThrow();
  }
  for (const parameters of [{ guidance: 2 }, { scheduler: 'arbitrary.module' }]) {
    expect(() => validateGenerateRequest({ ...base, prompt: 'Blue', parameters }, caps)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    expect(() => validateEditRequest({ ...base, instruction: 'Blue', sourceImage: '/in.png', parameters }, caps)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  }
});

it('resolves native strength only for edits, preserving defaults and endpoints', () => {
  const caps = listModels().find(model => model.id === 'sdxl')!.capabilities;
  expect(resolveParameters({}, caps, 'edit').strength).toBe(0.75);
  expect(resolveParameters({}, caps, 'generate')).not.toHaveProperty('strength');
  for (const strength of [0, 0.25, 1]) expect(resolveParameters({ strength }, caps, 'edit').strength).toBe(strength);
  expect(() => resolveParameters({ strength: 0.5 }, caps, 'generate')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
});
