import { createHash } from 'node:crypto';
import { readFile } from '../../storage.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PicPatchSdkError } from '../../errors.ts';
import type { EngineIdentity, EngineRecord, PythonRuntime } from './types.ts';
import { pythonVersion } from './versions.ts';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
/** The package's runtimes folder, from this module's own path. Not new URL(..., import.meta.url): a bundler treats that pattern as an asset import. */
const runtimes = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runtimes');
/** What each runtime's environment must import (module:attribute names an export), and whether it needs PyTorch's Metal backend. */
const probes: Record<PythonRuntime, { modules: string[]; metal: boolean }> = {
  mflux: { modules: ['mflux', 'mlx.core', 'torch', 'jsonschema', 'referencing', 'transformers'], metal: false },
  dreamo: { modules: ['torch', 'torchvision', 'diffusers', 'transformers', 'accelerate', 'peft', 'timm', 'einops', 'jsonschema'], metal: true },
  diffusers: { modules: ['torch', 'torchvision', 'diffusers:GlmImagePipeline', 'diffusers:Flux2Pipeline', 'transformers', 'accelerate', 'jsonschema'], metal: true },
};
export function runtimePaths(runtime: PythonRuntime = 'mflux') {
  if (!['mflux', 'dreamo', 'diffusers'].includes(runtime)) throw new PicPatchSdkError('INVALID_REQUEST', 'Unknown engine runtime.');
  const projectDirectory = join(runtimes, runtime);
  const { modules, metal } = probes[runtime];
  return { projectDirectory, probePath: join(runtimes, 'common', 'engine_probe.py'), probeArguments: [join(projectDirectory, 'uv.lock'), pythonVersion, ...modules, ...(metal ? ['--metal'] : [])] };
}
export async function engineDefinition(runtime: PythonRuntime = 'mflux') {
  const { projectDirectory } = runtimePaths(runtime);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'The managed Python runtime requires macOS arm64.');
  const [manifest, lock] = await Promise.all([readFile(join(projectDirectory, 'pyproject.toml'), 'utf8'), readFile(join(projectDirectory, 'uv.lock'), 'utf8')]);
  return { identity: identifyEngine(manifest, lock, runtime), manifest, lock };
}
export function identifyEngine(manifest: string, lock: string, runtime: PythonRuntime = 'mflux'): EngineIdentity {
  const fields = { platform: 'darwin', architecture: 'arm64', python: pythonVersion, dependencies: runtime === 'mflux' ? 'inference' : `${runtime}-inference` as const, lockSha256: hash(lock), manifestSha256: hash(manifest) } as const;
  return { id: hash(JSON.stringify({ version: 1, ...fields })), ...fields };
}
export function validRecord(value: unknown, identity: EngineIdentity): value is EngineRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as EngineRecord;
  return Object.keys(record).sort().join(',') === 'identity,installation,version' && record.version === 1 &&
    typeof record.installation === 'string' && new RegExp(`^${identity.id}-[a-f0-9-]{36}$`).test(record.installation) &&
    !!record.identity && Object.keys(record.identity).length === Object.keys(identity).length &&
    Object.entries(identity).every(([key, entry]) => (record.identity as unknown as Record<string, unknown>)[key] === entry);
}
