import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { checkSignal } from '../operations.ts';
import { PicPatchSdkError } from '../errors.ts';

export type Header = Record<string, { shape?: number[] }>;
/** Safetensors' metadata only; never deserialize executable formats or load tensors. */
export async function safetensorsHeader(path: string, signal?: AbortSignal): Promise<Header> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 8) throw new PicPatchSdkError('MODEL_IO', 'Invalid safetensors asset.');
    const prefix = Buffer.alloc(8);
    if ((await file.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new PicPatchSdkError('MODEL_IO', 'Incomplete safetensors header.');
    const length = prefix.readBigUInt64LE();
    // The safetensors format itself limits metadata to 100 MB.
    if (length > 100_000_000n || length < 2n || length > BigInt(info.size - 8)) throw new PicPatchSdkError('MODEL_IO', 'Invalid safetensors header length.');
    const bytes = Buffer.alloc(Number(length));
    let offset = 0;
    while (offset < bytes.length) {
      checkSignal(signal);
      const read = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset + 8);
      if (!read.bytesRead) throw new PicPatchSdkError('MODEL_IO', 'Incomplete safetensors header.');
      offset += read.bytesRead;
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PicPatchSdkError('MODEL_IO', 'Invalid safetensors metadata.');
    return value as Header;
  } finally { await file.close(); }
}
