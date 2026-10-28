// What a published image carries, so it can be shared as it is. A generated image
// carries no metadata. An edit keeps its source image's metadata unchanged, with its pixels turned
// back to the source's stored orientation and converted to its colour profile so those tags stay
// true; only an EXIF preview thumbnail, which would show the image before the edit, is dropped.
// PNG has no place for IPTC records or JPEG comments, so those are the only source metadata a PNG
// output cannot carry.
import { crc32 } from 'node:zlib';
import { join } from 'node:path';
import sharp, { type Sharp } from './sharp.ts';
import { readFile, writeFile } from '../storage.ts';

interface Chunk { type: string; data: Buffer }
/** The metadata an edit carries from its source image into its output. */
export interface SourceMetadata { format: string; orientation: number; icc?: Buffer; chunks: Chunk[] }

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngChunks(bytes: Buffer): Chunk[] {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) throw new Error('Not a PNG file.');
  const chunks: Chunk[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    chunks.push({ type: bytes.toString('latin1', offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}
export function encodePng(chunks: Chunk[]): Buffer {
  return Buffer.concat([signature, ...chunks.map(({ type, data }) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  })]);
}

/** Chunks that describe pixel storage or animation, which the output's own encoding defines. */
const pixelChunks = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'bKGD', 'hIST', 'sBIT', 'sPLT', 'acTL', 'fcTL', 'fdAT']);
/** Unsafe-to-copy chunks that stay true because the output keeps the source's colour and orientation. */
const keptUnsafe = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI', 'tIME']);
/** A PNG chunk is safe to copy into an image with changed pixels when its fourth letter is lower case. */
const carried = (type: string) => !pixelChunks.has(type) && (keptUnsafe.has(type) || type.charCodeAt(3) >= 0x61);

/** EXIF as a bare TIFF structure, without its preview thumbnail (IFD1 and the bytes it points to). */
export function withoutThumbnail(exif: Buffer): Buffer {
  const tiff = Buffer.from(exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? exif.subarray(6) : exif);
  const little = tiff.toString('latin1', 0, 2) === 'II';
  if (tiff.length < 8 || (!little && tiff.toString('latin1', 0, 2) !== 'MM')) return tiff;
  const u16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  const inside = (at: number, bytes: number) => at >= 8 && at + bytes <= tiff.length;
  if (u16(2) !== 42 || !inside(u32(4), 2)) return tiff;
  const ifd0 = u32(4); const next = ifd0 + 2 + u16(ifd0) * 12;
  if (!inside(next, 4)) return tiff;
  const ifd1 = u32(next);
  if (ifd1 === 0 || !inside(ifd1, 2)) return tiff;
  const entries = u16(ifd1); const table = 2 + entries * 12 + 4;
  if (!inside(ifd1, table)) return tiff;
  const values = new Map<number, number>();
  for (let index = 0; index < entries; index++) {
    const entry = ifd1 + 2 + index * 12;
    if (u32(entry + 4) === 1) values.set(u16(entry), u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));
  }
  // A JPEG thumbnail (0x0201/0x0202) or a single-strip uncompressed one (0x0111/0x0117).
  for (const [offset, length] of [[0x0201, 0x0202], [0x0111, 0x0117]] as const) {
    const at = values.get(offset); const bytes = values.get(length);
    if (at !== undefined && bytes !== undefined && inside(at, bytes)) tiff.fill(0, at, at + bytes);
  }
  tiff.fill(0, ifd1, ifd1 + table);
  if (little) tiff.writeUInt32LE(0, next); else tiff.writeUInt32BE(0, next);
  return tiff;
}

const itxt = (keyword: string, text: Buffer) => ({ type: 'iTXt', data: Buffer.concat([Buffer.from(`${keyword}\0\0\0\0\0`, 'latin1'), text]) });
function physical(density: number): Chunk {
  const perMetre = Math.round(density / 0.0254);
  const data = Buffer.alloc(9); data.writeUInt32BE(perMetre, 0); data.writeUInt32BE(perMetre, 4); data[8] = 1;
  return { type: 'pHYs', data };
}
/** Reads what an edit's output carries from its source, from the operation's private snapshot of it. */
export async function sourceMetadata(snapshot: string): Promise<SourceMetadata> {
  const metadata = await sharp(snapshot, { limitInputPixels: false }).metadata();
  const format = metadata.format ?? '';
  const base = { format, orientation: metadata.orientation ?? 1, ...(metadata.icc ? { icc: metadata.icc } : {}) };
  if (format === 'png') {
    const chunks = pngChunks(await readFile(snapshot)).filter(chunk => carried(chunk.type))
      .map(chunk => chunk.type === 'eXIf' ? { type: 'eXIf', data: withoutThumbnail(chunk.data) } : chunk);
    return { ...base, chunks };
  }
  const chunks: Chunk[] = [];
  if (metadata.exif) chunks.push({ type: 'eXIf', data: withoutThumbnail(metadata.exif) });
  if (metadata.xmp) chunks.push(itxt('XML:com.adobe.xmp', metadata.xmp));
  if (metadata.density) chunks.push(physical(metadata.density));
  return { ...base, chunks };
}

/** Undoes the turn autoOrient applied to a stored orientation. sharp mirrors before it rotates. */
function storedOrientation(image: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2: return image.flop();
    case 3: return image.rotate(180);
    case 4: return image.flip();
    case 5: return image.rotate(90).flip();
    case 6: return image.rotate(270);
    case 7: return image.rotate(90).flop();
    case 8: return image.rotate(90);
    default: return image;
  }
}
/**
 * Writes the published PNG from upright sRGB pixels: with no source, pixels alone; with a source, in
 * its stored orientation and colour profile, carrying its metadata. The file gets an ordinary mode.
 */
export async function finishImage(upright: string, target: string, directory: string, source?: SourceMetadata): Promise<void> {
  let image = sharp(upright, { limitInputPixels: false });
  if (source) image = storedOrientation(image, source.orientation);
  const convert = source?.icc !== undefined;
  if (convert) {
    const profile = join(directory, 'source.icc');
    await writeFile(profile, source!.icc!, { flag: 'wx', mode: 0o600 });
    image = image.withIccProfile(profile);
  }
  const encoded = pngChunks(await image.png().timeout({ seconds: 60 }).toBuffer());
  const own = encoded.filter(chunk => pixelChunks.has(chunk.type) && chunk.type !== 'IHDR');
  // A PNG source brings its own colour chunks; another format's profile is the one the conversion attached.
  const profile = convert && source!.format !== 'png' ? encoded.filter(chunk => chunk.type === 'iCCP') : [];
  await writeFile(target, encodePng([encoded[0]!, ...profile, ...(source?.chunks ?? []), ...own]), { flag: 'wx' });
}
