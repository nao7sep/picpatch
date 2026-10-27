import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/** Small previews of immutable session images, resized off the main thread and kept for the most recent paths. */
export class Thumbnails {
  private cache = new Map<string, Buffer>();
  private inFlight = new Map<string, Promise<Buffer>>();
  constructor(private size: number, private limit = 400) {}
  get(path: string): Promise<Buffer> {
    const cached = this.cache.get(path);
    if (cached) { this.cache.delete(path); this.cache.set(path, cached); return Promise.resolve(cached); }
    const active = this.inFlight.get(path);
    if (active) return active;
    const made = this.make(path).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, made);
    return made;
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
