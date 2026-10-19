// Provides the uv executable the packaged app bundles for explicit engine setup
// (node scripts/prepare-tools.mjs). The version and archive digest are pinned; the
// archive, executable and notices are cached under node_modules/.cache, so a prepared
// checkout needs no network. App startup never downloads tools.
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const execute = promisify(execFile);
const VERSION = "0.13.1";
const ARCHIVE_SHA256 = "cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2";
export const UV_DIRECTORY = fileURLToPath(new URL(`../node_modules/.cache/picpatch-desktop/uv-${VERSION}/`, import.meta.url));
const executable = join(UV_DIRECTORY, "uv");
const notices = join(UV_DIRECTORY, "THIRD_PARTY_NOTICES");

const exists = (path) => access(path).then(() => true, () => false);

async function download(url, timeout) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The bundled uv is currently qualified for Apple Silicon macOS only.");
}
if (!(await exists(executable)) || !(await exists(notices))) {
  await mkdir(UV_DIRECTORY, { recursive: true });
  const archive = join(UV_DIRECTORY, "archive.tar.gz");
  const bytes = (await exists(archive)) ? await readFile(archive)
    : await download(`https://github.com/astral-sh/uv/releases/download/${VERSION}/uv-aarch64-apple-darwin.tar.gz`, 120_000);
  if (createHash("sha256").update(bytes).digest("hex") !== ARCHIVE_SHA256) throw new Error("uv archive checksum mismatch.");
  await writeFile(archive, bytes);
  await execute("/usr/bin/tar", ["-xzf", archive, "-C", UV_DIRECTORY, "uv-aarch64-apple-darwin/uv"]);
  await rename(join(UV_DIRECTORY, "uv-aarch64-apple-darwin/uv"), executable);
  const licences = await Promise.all(["LICENSE-MIT", "LICENSE-APACHE"].map(async (name) =>
    (await download(`https://raw.githubusercontent.com/astral-sh/uv/${VERSION}/${name}`, 30_000)).toString("utf8")));
  await writeFile(notices, `uv ${VERSION} https://github.com/astral-sh/uv/tree/${VERSION}\n\n${licences.join("\n")}`);
}
console.log((await execute(executable, ["--version"], { timeout: 5000 })).stdout.trim());
