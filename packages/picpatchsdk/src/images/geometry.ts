import { PicPatchSdkError } from '../errors.ts';
import type { InputGeometry, ModelCapabilities } from '../types.ts';
export type GeometryPolicy = ModelCapabilities['inputGeometry'];

// MFLUX uses Python's round (ties to even), not JavaScript's ties toward +infinity.
function roundEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
}

/** Pure geometry for already validated image metadata. No upscaling or output-size coupling. */
export function inputGeometry(width: number, height: number, orientation = 1, policy?: GeometryPolicy): Omit<InputGeometry, 'path'> {
  const originalSize = { width, height };
  const orientedSize = orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { ...originalSize };
  let scaledSize = { ...orientedSize };
  if (policy === 'klein-reference' && orientedSize.width * orientedSize.height > 1024 * 1024) {
    const scale = Math.sqrt(1024 * 1024 / (orientedSize.width * orientedSize.height));
    scaledSize = { width: roundEven(orientedSize.width * scale), height: roundEven(orientedSize.height * scale) };
  }
  const preparedSize = policy === 'klein-reference'
    ? { width: scaledSize.width - scaledSize.width % 16, height: scaledSize.height - scaledSize.height % 16 }
    : { ...scaledSize };
  if (preparedSize.width < 1 || preparedSize.height < 1) throw new PicPatchSdkError('INVALID_IMAGE', 'Image is too small or narrow for this model after downscaling; each prepared side must be at least 16 pixels.');
  return { originalSize, orientedSize, scaledSize, preparedSize,
    crop: { left: Math.floor((scaledSize.width - preparedSize.width) / 2), top: Math.floor((scaledSize.height - preparedSize.height) / 2) } };
}
