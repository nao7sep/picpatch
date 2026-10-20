import { expect, it } from 'vitest';
import { hostId, runtimeHosts, supportsRuntime } from '../../src/hosts.ts';
import { archiveTool, toolEnvironment, venvPython } from '../../src/platform.ts';
import { nativeReleaseFor, nativeReleases, nativeRevision } from '../../src/runtime/engine/native-release.ts';
import { probeCommit } from '../../src/runtime/engine/native.ts';
import { listModels } from '../../src/index.ts';
const mac = { platform: 'darwin', arch: 'arm64' }, windows = { platform: 'win32', arch: 'x64' };
it('knows which runtimes each host can run', () => {
  expect([hostId(mac), hostId(windows), hostId({ platform: 'linux', arch: 'x64' }), hostId({ platform: 'win32', arch: 'arm64' })]).toEqual(['darwin-arm64', 'win32-x64', undefined, undefined]);
  for (const runtime of ['mflux', 'dreamo', 'diffusers'] as const) { expect(supportsRuntime(runtime, mac)).toBe(true); expect(supportsRuntime(runtime, windows)).toBe(false); }
  expect(supportsRuntime('stable-diffusion.cpp', windows)).toBe(true); expect(runtimeHosts('stable-diffusion.cpp')).toEqual(['darwin-arm64', 'win32-x64']);
});
it('lists every model with its hosts and whether this computer runs it', () => {
  for (const model of listModels()) {
    expect(model.runtime.hosts).toEqual(runtimeHosts(model.runtime.name));
    expect(model.supported).toBe(supportsRuntime(model.runtime.name));
  }
});
it('pins one revision of the native engine for each host, with exactly the files it uses', () => {
  expect(nativeReleaseFor(mac)).toBe(nativeReleases['darwin-arm64']); expect(nativeReleaseFor(windows)).toBe(nativeReleases['win32-x64']);
  expect(nativeReleaseFor({ platform: 'linux', arch: 'x64' })).toBeUndefined();
  expect(nativeReleases['win32-x64'].executable).toMatch(/\.exe$/);
  for (const pinned of Object.values(nativeReleases)) { expect(pinned.url).toContain(`-${nativeRevision.slice(0, 7)}-`); expect(pinned.files).toHaveProperty(pinned.executable); }
});
it('reads the engine banner with either line ending', () => {
  expect(probeCommit('stable-diffusion.cpp version unknown, commit 95b3090\nusage')).toBe('95b3090');
  expect(probeCommit('stable-diffusion.cpp version unknown, commit 95b3090\r\nusage')).toBe('95b3090');
  expect(probeCommit('something else')).toBeUndefined();
});
it('starts Windows tools with the folders Windows needs and no caller environment', () => {
  const environment = toolEnvironment(windows, ['C:\\tools']);
  expect(environment).toMatchObject({ SystemRoot: expect.any(String), windir: expect.any(String), TEMP: expect.any(String) });
  expect(environment.PATH!.split(';')[0]).toBe('C:\\tools'); expect(environment.PATH).toContain('\\System32');
  expect(toolEnvironment(mac).PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  expect(archiveTool(windows)).toMatch(/\\System32\\tar\.exe$/); expect(archiveTool(mac)).toBe('/usr/bin/tar');
  expect(venvPython('C:\\env', windows)).toBe('C:\\env\\Scripts\\python.exe'); expect(venvPython('/env', mac)).toBe('/env/bin/python');
});
