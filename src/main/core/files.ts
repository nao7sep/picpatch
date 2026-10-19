import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
/** One app owner serializes saves. Keep the prior file until the complete replacement is synced. */
export async function writeJson(path: string, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const temp = join(dirname(path), `${basename(path, extname(path))}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp, path); published = true;
    const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    return bytes;
  } finally { if (!published) await rm(temp, { force: true }).catch(() => {}); }
}
