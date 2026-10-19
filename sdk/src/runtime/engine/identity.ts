import { createHash } from 'node:crypto';
import { readFile } from '../../storage.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PicPatchSdkError } from '../../errors.ts';
import type { EngineIdentity, EngineRecord, EngineRuntime } from './types.ts';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export function runtimePaths(runtime: EngineRuntime = 'mflux') {
  if (!['mflux', 'dreamo', 'diffusers'].includes(runtime)) throw new PicPatchSdkError('INVALID_REQUEST', 'Unknown engine runtime.');
  return { projectDirectory: fileURLToPath(new URL(`../../../runtimes/${runtime}/`, import.meta.url)), probePath: fileURLToPath(new URL(`../../../runtimes/${runtime}/engine_probe.py`, import.meta.url)) };
}
export async function engineDefinition(runtime: EngineRuntime = 'mflux') {
  const { projectDirectory } = runtimePaths(runtime);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new PicPatchSdkError('UNSUPPORTED_CAPABILITY', 'The managed Python runtime requires macOS arm64.');
  const [manifest, lock] = await Promise.all([readFile(join(projectDirectory, 'pyproject.toml'), 'utf8'), readFile(join(projectDirectory, 'uv.lock'), 'utf8')]);
  return { identity: identifyEngine(manifest, lock, runtime), manifest, lock };
}
export function identifyEngine(manifest: string, lock: string, runtime: EngineRuntime = 'mflux'): EngineIdentity {
  const fields = { platform: 'darwin', architecture: 'arm64', python: '3.15.0', dependencies: runtime === 'mflux' ? 'inference' : `${runtime}-inference` as const, lockSha256: hash(lock), manifestSha256: hash(manifest) } as const;
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
