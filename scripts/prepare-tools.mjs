// Explicit build prerequisite; ordinary builds and app startup never download tools.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const execute = promisify(execFile);
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Bundled uv is currently qualified for Apple Silicon macOS only.');
const version = '0.13.1';
const expected = 'cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2';
const directory = fileURLToPath(new URL(`../node_modules/.cache/picpatch-desktop/uv-${version}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const archive = join(directory, 'archive.tar.gz');
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes) {
  const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${version}/uv-aarch64-apple-darwin.tar.gz`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`uv download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer()); await writeFile(archive, bytes);
}
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('uv archive checksum mismatch.');
await execute('/usr/bin/tar', ['-xzf', archive, '-C', directory, 'uv-aarch64-apple-darwin/uv']);
for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  const response = await fetch(`https://raw.githubusercontent.com/astral-sh/uv/${version}/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`uv notice download failed: ${response.status}`);
  await writeFile(join(directory, name), await response.text());
}
console.log((await execute(join(directory, 'uv-aarch64-apple-darwin/uv'), ['--version'], { timeout: 5000 })).stdout.trim());
