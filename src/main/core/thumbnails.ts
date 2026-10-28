import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Small previews of immutable session images, made one at a time and kept for the most recent paths; a repeated
 * request waits its turn and finds the cache. Measured on real generated PNGs of 1-3 MB: about 30 ms each one at a
 * time (libvips already spreads one decode over its threads), so a screen of rail covers fills in a few tenths of a
 * second, and the window caches each immutable response after that.
 */
export class Thumbnails {
  private cache = new Map<string, Buffer>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private size: number, private limit = 400) {}
  get(path: string): Promise<Buffer> {
    const next = this.tail.then(() => this.cached(path) ?? this.make(path));
    this.tail = next.catch(() => {});
    return next;
  }
  private cached(path: string): Buffer | undefined {
    const cached = this.cache.get(path);
    if (cached) { this.cache.delete(path); this.cache.set(path, cached); }
    return cached;
  }
  private async make(path: string): Promise<Buffer> {
    // Decoding from memory keeps libvips from holding the file open, which on Windows would block deleting its session.
    const bytes = await readFile(path);
    const made = await sharp(bytes, { limitInputPixels: false }).rotate().resize(this.size, this.size, { fit: 'outside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    this.cache.set(path, made);
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    return made;
  }
}
