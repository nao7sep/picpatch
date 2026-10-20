import { describe, expect, it } from 'vitest';
import { contractAjv, contractValidator } from '../../src/contracts.ts';
import { validateEditRequest, validateGenerateRequest, listModels, PicPatchSdkError, type EditRequest, type ModelCapabilities } from '../../src/index.ts';
const request = (): EditRequest => ({ model: 'test', instruction: 'Combine these subjects', outputPath: '/out.png', references: [
  { id: 'alice', role: 'subject', images: ['/alice-front.png', '/alice-side.png'] },
  { id: 'bob', role: 'subject', images: ['/bob-front.png', '/bob-side.png'] },
] });
const capability = (): ModelCapabilities => ({ model: 'test', instructionEditing: true, referenceRoles: ['subject'], maskMode: 'none', maxReferenceImages: 4 });
describe('editing contracts', () => {
  it('preserves grouped order and isolates caller mutation', () => {
    const input = request(); const validated = validateEditRequest(input, capability());
    expect(validated).toEqual(input);
    input.references![0].images[0] = '/changed.png';
    expect(validated.references![0].images[0]).toBe('/alice-front.png');
  });
  it.each([
    { instruction: '  ' }, { seed: -1 }, { seed: 2 ** 32 }, { seed: NaN }, { seed: 0.5 },
    { references: [] }, { references: undefined }, { maskImage: '/mask.png' }, { outputPath: 'relative.png' },
    { outputPath: '/out.jpg' }, { outputPath: '/alice-front.png' }, { size: { width: 0, height: 64 } },
    { surprise: true }, { sourceImage: '/bad\0.png' },
    { references: [{ id: 'alice', role: 'subject', images: [] }] },
    { references: [{ id: 'alice', role: 'subject', images: ['/a.png'] }, { id: 'alice', role: 'subject', images: ['/b.png'] }] },
    { references: [{ id: 'alice', role: 'subject', images: ['/a.png', '/x/../a.png'] }] },
  ])('rejects invalid requests (%j)', change => {
    expect(() => validateEditRequest({ ...request(), ...change })).toThrow(PicPatchSdkError);
  });
  it('accepts source-only edits and boundary seeds', () => {
    for (const seed of [0, 2 ** 32 - 1]) expect(validateEditRequest({ model: 'test', instruction: 'Edit', sourceImage: '/source.png', maskImage: '/mask.png', outputPath: '/out.png', seed }).seed).toBe(seed);
  });
  it.each([{ maxReferenceImages: 3 }, { instructionEditing: false }, { referenceRoles: [] }, { model: 'other' }])('checks actual model capability (%j)', change => {
    expect(() => validateEditRequest(request(), { ...capability(), ...change })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });
  it('enforces mask and size capabilities', () => {
    expect(() => validateEditRequest({ ...request(), sourceImage: '/src.png', maskImage: '/mask.png' }, capability())).toThrow(PicPatchSdkError);
    const caps = { ...capability(), size: { widthMultiple: 16, heightMultiple: 16, maxWidth: 1024 } };
    expect(() => validateEditRequest({ ...request(), size: { width: 65, height: 64 } }, caps)).toThrow(PicPatchSdkError);
    expect(() => validateEditRequest({ ...request(), size: { width: 1040, height: 64 } }, caps)).toThrow(PicPatchSdkError);
    expect(validateEditRequest({ ...request(), size: { width: 64, height: 64 } }, caps).size).toEqual({ width: 64, height: 64 });
  });
  it('classifies invalid worker capabilities separately', () => {
    expect(() => validateEditRequest(request(), { ...capability(), maxReferenceImages: -1 })).toThrow(PicPatchSdkError);
  });
  it('retains causes and cancellation classification', () => {
    const cause = new Error('cause');
    expect(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Unavailable', { cause }).cause).toBe(cause);
    expect(new PicPatchSdkError('CANCELLED', 'The operation was cancelled.')).toMatchObject({ kind: 'cancelled', code: 'CANCELLED' });
  });
});

// Geometry describes actual model support, not the host computer's memory budget.
it('enforces the Ideogram 4 native dimension interval for generation', () => {
  const caps = listModels().find(model => model.id === 'ideogram4-fp8')!.capabilities;
  const input = { model: caps.model, prompt: 'A bowl.', outputPath: '/output.png' };
  for (const size of [{ width: 256, height: 2048 }, { width: 2048, height: 256 }]) {
    expect(validateGenerateRequest({ ...input, size }, caps).size).toEqual(size);
  }
  for (const size of [{ width: 240, height: 256 }, { width: 256, height: 240 }, { width: 2064, height: 256 }, { width: 256, height: 2064 }, { width: 257, height: 256 }]) {
    expect(() => validateGenerateRequest({ ...input, size }, caps)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  }
});

it('compiles each contract definition once, however often it is validated', () => {
  const compile = contractAjv.compile.bind(contractAjv); let compiled = 0;
  contractAjv.compile = ((schema: object) => { compiled++; return compile(schema); }) as typeof contractAjv.compile;
  try {
    const first = contractValidator('LocalLora');
    for (let i = 0; i < 3; i++) expect(contractValidator('LocalLora')).toBe(first);
    expect(compiled).toBeLessThanOrEqual(1);
  } finally { contractAjv.compile = compile; }
});
