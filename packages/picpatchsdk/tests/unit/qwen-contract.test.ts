import { expect, it } from 'vitest';
import { validateEditRequest, validateGenerateRequest, type ModelCapabilities } from '../../src/index.ts';

const capabilities: ModelCapabilities = { model: 'qwen-image-2.1', instructionEditing: true, textToImage: true,
  referenceRoles: ['subject', 'object', 'style', 'background'], maskMode: 'none', maxConditioningImages: 10,
  size: { widthMultiple: 32, heightMultiple: 32 } };
const request = { model: capabilities.model, instruction: 'Use blue.', outputPath: '/out.png',
  references: [{ id: 'subject', role: 'subject' as const, images: Array.from({ length: 10 }, (_, i) => `/r${i}.png`) }] };
it('counts the source in Qwen 2.1 total conditioning, independently of grouped reference limits', () => {
  expect(validateEditRequest(request, capabilities)).toEqual(request);
  expect(() => validateEditRequest({ ...request, sourceImage: '/source.png' }, capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  const nine = [{ ...request.references[0]!, images: request.references[0]!.images.slice(0, 9) }];
  expect(validateEditRequest({ ...request, sourceImage: '/source.png', references: nine }, capabilities)).toMatchObject({ sourceImage: '/source.png' });
  expect(() => validateEditRequest(request, { ...capabilities, maxReferenceImages: 9 })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
});
it('applies model geometry without imposing the test-host memory budget', () => {
  for (const width of [16, 48]) expect(() => validateGenerateRequest({ model: capabilities.model, prompt: 'A bowl.', outputPath: '/out.png', size: { width, height: 32 } }, capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  expect(validateGenerateRequest({ model: capabilities.model, prompt: 'A bowl.', outputPath: '/out.png', size: { width: 4096, height: 4096 } }, capabilities).size).toEqual({ width: 4096, height: 4096 });
  expect(() => validateEditRequest({ ...request, sourceImage: '/source.png', references: undefined, maskImage: '/mask.png', size: { width: 32, height: 32 } }, capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
});
