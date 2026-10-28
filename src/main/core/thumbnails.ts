import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Small previews of session images, made one at a time so a screen of covers never reads and decodes many originals at
 * once. Nothing is kept here: the window reuses a loaded thumbnail URL when it is shown again, so only a reloaded window
 * asks twice, and a 1-4 MB generated PNG takes about 15-20 ms (a 2048 px one about 40 ms).
 */
export class Thumbnails {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private size: number) {}
  get(path: string): Promise<Buffer> {
    const next = this.tail.then(() => this.make(path));
    this.tail = next.catch(() => {});
    return next;
  }
  private async make(path: string): Promise<Buffer> {
    // Decoding from memory keeps libvips from holding the file open, which on Windows would block deleting its session.
    const bytes = await readFile(path);
    return sharp(bytes, { limitInputPixels: false }).rotate().resize(this.size, this.size, { fit: 'outside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  }
}
