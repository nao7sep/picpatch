/**
 * Replaces the runnable package with a packaged candidate, so a failed rebuild
 * leaves the previous package in place. The old package is moved aside first and
 * moved back if the candidate cannot take its place. Both rebuild launchers use it.
 * CLI: node publish-package.mjs <candidate> <destination>
 */
import { rename, rm } from "node:fs/promises";

const [candidate, destination] = process.argv.slice(2);
if (!candidate || !destination) throw new Error("Expected candidate and destination folders");
const previous = `${destination}-previous`;

await rm(previous, { recursive: true, force: true });
let movedPrevious = false;
try {
  await rename(destination, previous);
  movedPrevious = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  await rename(candidate, destination);
} catch (error) {
  if (movedPrevious) await rename(previous, destination);
  throw error;
}
if (movedPrevious) await rm(previous, { recursive: true, force: true });
