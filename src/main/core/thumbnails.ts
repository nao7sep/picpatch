import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import sharp from 'sharp';

/** Small previews of immutable session images, resized off the main thread and kept for the most recent paths. */
export class Thumbnails {
  private cache = new Map<string, Buffer>();
  private inFlight = new Map<string, Promise<Buffer>>();
  // Each Sharp image can use a libvips worker team; admit only as many teams as the host can run.
  private concurrency = Math.max(1, Math.floor(availableParallelism() / sharp.concurrency()));
  private running = 0;
  private waiting: (() => void)[] = [];
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
    if (this.running < this.concurrency) this.running++;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try {
      // Admission covers reading too, so queued images do not retain whole original buffers.
      // Decoding from memory keeps libvips from holding the file open, which on Windows would block deleting its session.
      const bytes = await readFile(path);
      const made = await sharp(bytes, { limitInputPixels: false }).rotate().resize(this.size, this.size, { fit: 'outside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      this.cache.set(path, made);
      while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
      return made;
    } finally {
      // Transfer the slot directly to the next reader, retaining it until the decoder actually settles.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}
