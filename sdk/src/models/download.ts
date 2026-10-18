import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PicPatchSdkError } from '../errors.ts';
import { checkSignal } from '../operations.ts';

/** Internal transport seam: only production HTTPS URLs; fixtures substitute fetch. */
export async function downloadFile(url: string, path: string, bytes: number, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  const idle = new AbortController();
  const combined = AbortSignal.any([signal, idle.signal]);
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), 30_000); };
  arm();
  try {
    for (let redirects = 0; ; redirects++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password) throw new PicPatchSdkError('MODEL_IO', 'Model acquisition requires HTTPS without URL credentials.');
      checkSignal(combined);
      const response = await fetcher(target, { signal: combined, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects >= 8) throw new PicPatchSdkError('MODEL_IO', 'Model source returned an invalid redirect chain.');
        url = new URL(location, target).href;
        continue;
      }
      const length = response.headers.get('content-length');
      if (!response.ok || !response.body || (length !== null && Number(length) !== bytes)) {
        await response.body?.cancel();
        throw new PicPatchSdkError('MODEL_IO', 'Model source returned an unavailable file or an unexpected length.');
      }
      let received = 0;
      const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        arm(); received += chunk.length;
        callback(received > bytes ? new PicPatchSdkError('MODEL_IO', 'Model file exceeded its pinned length.') : null, received > bytes ? undefined : chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), count, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: combined });
      if (received !== bytes) throw new PicPatchSdkError('MODEL_IO', 'Model file did not match its pinned length.');
      return;
    }
  } catch (cause) {
    checkSignal(signal);
    if (idle.signal.aborted) throw new PicPatchSdkError('TIMEOUT', 'Model download stopped responding.', { cause });
    throw cause;
  } finally { clearTimeout(timer!); }
}
