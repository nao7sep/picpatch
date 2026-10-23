import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
/** One app owner serializes saves. Keep the prior file until the complete replacement is synced. */
export async function writeJson(path: string, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  return writeBytes(path, bytes);
}
export async function writeBytes(path: string, bytes: Buffer): Promise<Buffer> {
  const temp = join(dirname(path), `${basename(path, extname(path))}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp, path); published = true;
    // The rename is the publication; syncing the directory entry is best effort (Windows refuses it).
    if (process.platform !== 'win32') await syncDirectory(dirname(path)).catch(() => {});
    return bytes;
  } finally { if (!published) await rm(temp, { force: true }).catch(() => {}); }
}
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let directory;
  try { directory = await open(path, 'r'); await directory.sync(); }
  catch (error) {
    // Some removable filesystems expose no directory flush operation.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { await directory?.close(); }
}
