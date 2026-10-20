import { expect, it } from 'vitest';
import { hostId, runtimeHosts, supportsRuntime } from '../../src/hosts.ts';
import { archiveTool, ownedTermination, spawnOwnership, toolEnvironment, venvPython } from '../../src/platform.ts';
import { nativeReleaseFor, nativeReleases, nativeRevision } from '../../src/runtime/engine/native-release.ts';
import { missingDll, probeCommit, publishInstallation } from '../../src/runtime/engine/native.ts';
import { PicPatchSdkError } from '../../src/errors.ts';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
it('ends an owned Windows tree with taskkill and a POSIX one through its process group', () => {
  expect(ownedTermination(42, 'SIGTERM', 'darwin')).toEqual({ group: -42, signal: 'SIGTERM' });
  const windowsTree = ownedTermination(42, 'SIGTERM', 'win32');
  expect(windowsTree).toEqual({ command: expect.stringMatching(/\\System32\\taskkill\.exe$/), args: ['/PID', '42', '/T', '/F'] });
  // Windows children get no console window and stay in the parent's tree for taskkill /T.
  expect(spawnOwnership('win32')).toEqual({ detached: false, windowsHide: true });
  expect(spawnOwnership('darwin')).toEqual({ detached: true, windowsHide: true });
});
it('recognises the missing Visual C++ runtime by the DLL-not-found exit code', () => {
  const exit = (exitCode: number) => new PicPatchSdkError('ENGINE_UNAVAILABLE', 'Exited.', { details: { diagnostic: { phase: 'worker', causes: [{ kind: 'ProcessExit' }], exitCode } } });
  expect(missingDll(exit(3221225781))).toBe(true); expect(missingDll(exit(-1073741515))).toBe(true);
  expect(missingDll(exit(1))).toBe(false); expect(missingDll(new Error('other'))).toBe(false);
});
it('retries publishing while Windows antivirus holds the new engine, and nowhere else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-publish-'));
  try {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    let calls = 0; const flaky = async () => { if (++calls < 3) throw busy; };
    await publishInstallation(join(root, 'from'), join(root, 'to'), 'win32', flaky); expect(calls).toBe(3);
    calls = 0; await expect(publishInstallation(join(root, 'from'), join(root, 'to'), 'darwin', flaky)).rejects.toBe(busy); expect(calls).toBe(1);
    // A destination that already exists is the caller's to inspect, not a busy file to wait for.
    await mkdir(join(root, 'existing'));
    calls = 0; await expect(publishInstallation(join(root, 'from'), join(root, 'existing'), 'win32', flaky)).rejects.toBe(busy); expect(calls).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
