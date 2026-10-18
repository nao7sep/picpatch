import sharp from 'sharp';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutpaintCanvas } from '../contracts.generated.ts';
import { PicPatchSdkError } from '../errors.ts';
import { checkCancellation } from './validation.ts';

/** Expand normalized pixels without cropping/resizing; white mask marks only added canvas. */
export async function prepareOutpaint(source: { path: string; width: number; height: number }, canvas: OutpaintCanvas, directory: string, signal?: AbortSignal): Promise<{ sourceImage: string; maskImage: string }> {
  checkCancellation(signal);
  const margins = outpaintMargins(source, canvas);
  const sourceImage = join(directory, 'canvas.png');
  const maskImage = join(directory, 'canvas-mask.png');
  try {
    await sharp(source.path, { limitInputPixels: false }).extend({ ...margins, background: { r: 127, g: 127, b: 127, alpha: 1 } }).png().timeout({ seconds: 60 }).toFile(sourceImage);
    await chmod(sourceImage, 0o600);
    checkCancellation(signal);
    await sharp({ create: { width: source.width, height: source.height, channels: 3, background: 'black' }, limitInputPixels: false })
      .extend({ ...margins, background: 'white' }).toColourspace('b-w').png().timeout({ seconds: 60 }).toFile(maskImage);
    await chmod(maskImage, 0o600);
    checkCancellation(signal);
    return { sourceImage, maskImage };
  } catch (cause) {
    checkCancellation(signal);
    throw new PicPatchSdkError('IMAGE_IO', 'Could not prepare the outpaint canvas and mask.', { cause });
  }
}

export function outpaintMargins(source: { width: number; height: number }, canvas: OutpaintCanvas) {
  const right = canvas.size.width - source.width - canvas.left;
  const bottom = canvas.size.height - source.height - canvas.top;
  if (right < 0 || bottom < 0 || (canvas.left === 0 && canvas.top === 0 && right === 0 && bottom === 0)) {
    throw new PicPatchSdkError('INVALID_REQUEST', 'Outpaint canvas must contain the oriented source and add pixels on at least one side.');
  }
  return { left: canvas.left, top: canvas.top, right, bottom };
}
