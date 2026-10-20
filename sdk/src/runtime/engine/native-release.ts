import { hostId, type Host, type HostId } from '../../hosts.ts';

/** One official immutable release asset; each digest is pinned independently from GitHub release metadata. */
export interface NativeRelease {
  url: string;
  bytes: number;
  sha256: string;
  /** The CLI inside the archive. */
  executable: string;
  /** Every file extracted, with its exact size; nothing else in the archive is used. */
  files: Readonly<Record<string, number>>;
}
export const nativeRevision = '95b3090664d019fcf8fa032a44d1d4793ba244b8';
const base = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-975-95b3090/';
export const nativeReleases: Readonly<Record<HostId, NativeRelease>> = {
  'darwin-arm64': {
    url: `${base}sd-master-95b3090-bin-Darwin-macOS-26.6.2-arm64.zip`, bytes: 36488395, sha256: '2edf5a21c4b73f448c3a02c87925283b77aa94f1859c0d8e649134da68b40813', executable: 'sd-cli',
    files: { 'sd-cli': 3628424, 'libstable-diffusion.dylib': 89625208, 'ggml.txt': 1078, 'stable-diffusion.cpp.txt': 1062 },
  },
  // The Vulkan build carries every CPU build too and uses the CPU when no Vulkan driver is present.
  'win32-x64': {
    url: `${base}sd-master-95b3090-bin-win-vulkan-x64.zip`, bytes: 29371165, sha256: '17398d07ba89c2fba21b8662db69ecdd917888373e4f82779b7599e97a6b4bd3', executable: 'sd-cli.exe',
    files: {
      'sd-cli.exe': 661504, 'stable-diffusion.dll': 35563008, 'ggml.dll': 58368, 'ggml-base.dll': 685056, 'ggml-vulkan.dll': 40033280,
      'ggml-cpu-alderlake.dll': 999424, 'ggml-cpu-cannonlake.dll': 1044480, 'ggml-cpu-cascadelake.dll': 1043456, 'ggml-cpu-haswell.dll': 1000448, 'ggml-cpu-icelake.dll': 1043456,
      'ggml-cpu-sandybridge.dll': 1028608, 'ggml-cpu-skylakex.dll': 1044480, 'ggml-cpu-sse42.dll': 865792, 'ggml-cpu-x64.dll': 867328,
      'libwebp.dll': 373248, 'libwebpmux.dll': 41984, 'libsharpyuv.dll': 24576, 'webm.dll': 328192, 'ggml.txt': 1099, 'stable-diffusion.cpp.txt': 1082,
    },
  },
};
/** The pinned release for a host, or undefined where the native engine has none. */
export const nativeReleaseFor = (host?: Host): NativeRelease | undefined => { const id = hostId(host); return id ? nativeReleases[id] : undefined; };
