/** Pixel polarity is lossless: mask red becomes overlay alpha and alpha becomes
 * opaque grayscale on export, including partially painted edge pixels. */
export function maskToOverlay(pixels: Uint8ClampedArray) {
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i]!;
    pixels[i] = 0xf2; pixels[i + 1] = 0xa6; pixels[i + 2] = 0x5a; pixels[i + 3] = alpha;
  }
}

export function overlayToMask(pixels: Uint8ClampedArray) {
  let painted = false;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    painted ||= alpha !== 0;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = alpha; pixels[i + 3] = 255;
  }
  return painted;
}
