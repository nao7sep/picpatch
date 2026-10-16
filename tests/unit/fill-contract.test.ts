import { expect, it } from 'vitest';
import { validateEditRequest, validateGenerateRequest, type ModelCapabilities } from '../../src/index.ts';

const capabilities: ModelCapabilities = { model: 'fill', instructionEditing: true, textToImage: false,
  sourceImageRequired: true, maskRequired: true, referenceRoles: [], maxReferenceImages: 0, maskMode: 'native',
  size: { widthMultiple: 16, heightMultiple: 16 } };
const request = { model: 'fill', instruction: 'A blue bowl.', sourceImage: '/source.png', maskImage: '/mask.png', outputPath: '/output.png' };
it('admits native source/mask edits and rejects missing masks, references and generation before I/O', () => {
  expect(validateEditRequest(request, capabilities)).toEqual(request);
  const { maskImage: _mask, ...unmasked } = request;
  const { sourceImage: _source, ...referenceOnly } = unmasked;
  for (const input of [unmasked, { ...referenceOnly, references: [{ id: 'r', role: 'style', images: ['/reference.png'] }] },
    { ...request, references: [{ id: 'r', role: 'style', images: ['/reference.png'] }] }]) {
    expect(() => validateEditRequest(input, capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  }
  expect(() => validateGenerateRequest({ model: 'fill', prompt: 'A bowl.', outputPath: '/output.png' }, capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
});
