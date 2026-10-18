import { describe, expect, it } from 'vitest';
import { validateEditRequest, PicPatchUsageError, PicPatchRuntimeError, PicPatchCancelledError, type EditRequest, type ModelCapabilities } from '../../src/index.ts';
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
    expect(() => validateEditRequest({ ...request(), ...change })).toThrow(PicPatchUsageError);
  });
  it('accepts source-only edits and boundary seeds', () => {
    for (const seed of [0, 2 ** 32 - 1]) expect(validateEditRequest({ model: 'test', instruction: 'Edit', sourceImage: '/source.png', maskImage: '/mask.png', outputPath: '/out.png', seed }).seed).toBe(seed);
  });
  it.each([{ maxReferenceImages: 3 }, { instructionEditing: false }, { referenceRoles: [] }, { model: 'other' }])('checks actual model capability (%j)', change => {
    expect(() => validateEditRequest(request(), { ...capability(), ...change })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });
  it('enforces mask and size capabilities', () => {
    expect(() => validateEditRequest({ ...request(), sourceImage: '/src.png', maskImage: '/mask.png' }, capability())).toThrow(PicPatchUsageError);
    const caps = { ...capability(), size: { widthMultiple: 16, heightMultiple: 16, maxWidth: 1024 } };
    expect(() => validateEditRequest({ ...request(), size: { width: 65, height: 64 } }, caps)).toThrow(PicPatchUsageError);
    expect(() => validateEditRequest({ ...request(), size: { width: 1040, height: 64 } }, caps)).toThrow(PicPatchUsageError);
    expect(validateEditRequest({ ...request(), size: { width: 64, height: 64 } }, caps).size).toEqual({ width: 64, height: 64 });
  });
  it('classifies invalid worker capabilities separately', () => {
    expect(() => validateEditRequest(request(), { ...capability(), maxReferenceImages: -1 })).toThrow(PicPatchRuntimeError);
  });
  it('retains causes and cancellation classification', () => {
    const cause = new Error('cause');
    expect(new PicPatchRuntimeError('WORKER_UNAVAILABLE', 'Unavailable', { cause }).cause).toBe(cause);
    expect(new PicPatchCancelledError()).toMatchObject({ category: 'cancelled', code: 'CANCELLED' });
  });
});
