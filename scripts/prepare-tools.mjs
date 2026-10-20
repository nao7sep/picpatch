// Provides the uv executable the macOS app bundles for explicit Python engine setup
// (node scripts/prepare-tools.mjs). The version and archive digest are pinned here only;
// the staged folder carries no version in its name, so packaging and the app read it
// without repeating the version, and a recorded version file restages it when the pin
// changes. The archive and executable are cached under node_modules/.cache, so a
// prepared checkout needs no network. App startup never downloads tools.
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const execute = promisify(execFile);
const VERSION = "0.13.1";
const ARCHIVE_SHA256 = "cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2";
const UV_DIRECTORY = fileURLToPath(new URL("../node_modules/.cache/picpatch-desktop/uv/", import.meta.url));
const executable = join(UV_DIRECTORY, "uv");
const stagedVersion = join(UV_DIRECTORY, "version");

const exists = (path) => access(path).then(() => true, () => false);

// Windows runs only the native engine, which installs without uv, so nothing is bundled there.
if (process.platform === "win32" && process.arch === "x64") {
  console.log("No bundled tools on Windows.");
  process.exit(0);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("PicPatch packages for Apple Silicon macOS and 64-bit Windows only.");
}
if (!(await exists(executable)) || (await readFile(stagedVersion, "utf8").catch(() => "")) !== VERSION) {
  await rm(UV_DIRECTORY, { recursive: true, force: true });
  await mkdir(UV_DIRECTORY, { recursive: true });
  const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${VERSION}/uv-aarch64-apple-darwin.tar.gz`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`uv download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== ARCHIVE_SHA256) throw new Error("uv archive checksum mismatch.");
  const archive = join(UV_DIRECTORY, "archive.tar.gz");
  await writeFile(archive, bytes);
  await execute("/usr/bin/tar", ["-xzf", archive, "-C", UV_DIRECTORY, "uv-aarch64-apple-darwin/uv"]);
  await rename(join(UV_DIRECTORY, "uv-aarch64-apple-darwin/uv"), executable);
  await rm(join(UV_DIRECTORY, "uv-aarch64-apple-darwin"), { recursive: true, force: true });
  await writeFile(stagedVersion, VERSION);
}
console.log((await execute(executable, ["--version"], { timeout: 5000 })).stdout.trim());
