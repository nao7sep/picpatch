// The hosts the SDK runs on and which runtimes each supports. No Node dependencies: the browser
// type entry re-exports these types.
export type HostId = 'darwin-arm64' | 'win32-x64';
export interface Host { platform: string; arch: string }
export type RuntimeName = 'mflux' | 'dreamo' | 'diffusers' | 'stable-diffusion.cpp';

/** This process's host (read through globalThis so the module also type-checks without Node types). */
export const currentHost = (): Host => { const { platform, arch } = (globalThis as unknown as { process: Host }).process; return { platform, arch }; };
/** The supported host this is, or undefined. */
export function hostId(host: Host = currentHost()): HostId | undefined {
  const id = `${host.platform}-${host.arch}`;
  return id === 'darwin-arm64' || id === 'win32-x64' ? id : undefined;
}
/** MLX is Apple-only and the Python adapters target Metal; the native engine has official Windows builds. */
const runtimeHostTable: Record<RuntimeName, readonly HostId[]> = {
  mflux: ['darwin-arm64'],
  dreamo: ['darwin-arm64'],
  diffusers: ['darwin-arm64'],
  'stable-diffusion.cpp': ['darwin-arm64', 'win32-x64'],
};
export const runtimeHosts = (runtime: RuntimeName): readonly HostId[] => runtimeHostTable[runtime];
export function supportsRuntime(runtime: RuntimeName, host: Host = currentHost()): boolean {
  const id = hostId(host);
  return id !== undefined && runtimeHostTable[runtime].includes(id);
}

