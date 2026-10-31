import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('picpatchsdk', async original => ({ ...await original<typeof import('picpatchsdk')>(), listModels: vi.fn(), openModel: vi.fn(), inspectEngine: vi.fn(), inspectNativeEngine: vi.fn() }));
import { listModels, openModel, inspectEngine, inspectNativeEngine, PicPatchSdkError, type ModelRegistration } from 'picpatchsdk';
import { modelReadiness } from '../../src/main/core/model-readiness.ts';
const registration: ModelRegistration = { model: { variant: 'flux2-klein-4b', directory: '/registered', manifest: { model: 'fixture', source: { repository: 'local', revision: 'a'.repeat(40) }, components: [{ path: 'weights.safetensors', role: 'weights', bytes: 1, sha256: 'a'.repeat(64) }] } } };
const settings = { profile: {}, registrations: {} };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listModels).mockReturnValue([{ id: 'a', acquisition: 'pinned', runtime: { name: 'mflux', engine: 'python' }, supported: true }, { id: 'b', acquisition: 'pinned', runtime: { name: 'mflux', engine: 'python' }, supported: true }, { id: 'external', acquisition: 'local', runtime: { name: 'stable-diffusion.cpp', engine: 'native' }, supported: true }] as never);
});
it('checks existing files and shares cheap engine inspection without loading models', async () => {
  vi.mocked(openModel).mockResolvedValue({ status: 'completed' } as never);
  vi.mocked(inspectEngine).mockResolvedValue({ status: 'ready' } as never);
  expect(await modelReadiness(settings)).toEqual({ a: 'ready', b: 'ready', external: 'missing' });
  expect(inspectEngine).toHaveBeenCalledTimes(1); expect(openModel).toHaveBeenCalledTimes(2); expect(inspectNativeEngine).not.toHaveBeenCalled();
});
it('distinguishes missing weights and missing engines', async () => {
  vi.mocked(openModel).mockResolvedValueOnce({ status: 'refused' } as never).mockResolvedValueOnce({ status: 'completed' } as never);
  vi.mocked(inspectEngine).mockResolvedValue({ status: 'missing' } as never);
  expect(await modelReadiness(settings)).toEqual({ a: 'missing', b: 'engineMissing', external: 'missing' });
});
it('leaves models without a build for this computer out of readiness', async () => {
  vi.mocked(listModels).mockReturnValue([{ id: 'mac-only', acquisition: 'pinned', runtime: { name: 'mflux', engine: 'python' }, supported: false }, { id: 'native', acquisition: 'pinned', runtime: { name: 'stable-diffusion.cpp', engine: 'native' }, supported: true }] as never);
  vi.mocked(openModel).mockResolvedValue({ status: 'completed' } as never);
  vi.mocked(inspectNativeEngine).mockResolvedValue({ status: 'ready' } as never);
  expect(await modelReadiness(settings)).toEqual({ native: 'ready' }); expect(inspectEngine).not.toHaveBeenCalled();
});
it('passes the caller’s signal and event hook to every SDK check', async () => {
  vi.mocked(openModel).mockResolvedValue({ status: 'completed' } as never);
  vi.mocked(inspectEngine).mockResolvedValue({ status: 'ready' } as never);
  const call = { signal: new AbortController().signal, onEvent: () => {} };
  await modelReadiness(settings, call);
  for (const mock of [openModel, inspectEngine]) for (const args of vi.mocked(mock).mock.calls) expect(args.at(-1)).toMatchObject(call);
  expect(vi.mocked(inspectEngine).mock.calls[0]![0]).toMatchObject({ runtime: 'mflux' });
});

it('keeps healthy models available when a registered resource cannot be read', async () => {
  const registered = { ...settings, registrations: { a: registration } };
  vi.mocked(openModel).mockRejectedValueOnce(new PicPatchSdkError('PERMISSION_DENIED', 'EACCES /private/sentinel'))
    .mockResolvedValue({ status: 'completed' } as never);
  vi.mocked(inspectEngine).mockResolvedValue({ status: 'ready' } as never);
  expect(await modelReadiness(registered)).toEqual({ a: { status: 'failed', notice: { key: 'error.storage' } }, b: 'ready', external: 'missing' });
  expect(inspectEngine).toHaveBeenCalledTimes(1);
});
it('shares a failed runtime probe only among that runtime’s dependent models', async () => {
  vi.mocked(openModel).mockResolvedValue({ status: 'completed' } as never);
  vi.mocked(inspectEngine).mockRejectedValue(new PicPatchSdkError('ENGINE_IO', 'hostile internal sentinel'));
  vi.mocked(inspectNativeEngine).mockResolvedValue({ status: 'ready' } as never);
  const found = await modelReadiness({ ...settings, registrations: { external: registration } });
  expect(found).toEqual({ a: { status: 'failed', notice: { key: 'error.engine' } }, b: { status: 'failed', notice: { key: 'error.engine' } }, external: 'ready' });
  expect(inspectEngine).toHaveBeenCalledTimes(1); expect(inspectNativeEngine).toHaveBeenCalledTimes(1);
});
it.each(['model', 'engine'])('propagates whole-operation cancellation from the %s probe', async stage => {
  const cancellation = new PicPatchSdkError('CANCELLED', 'Cancelled');
  vi.mocked(openModel).mockResolvedValue({ status: 'completed' } as never);
  if (stage === 'model') vi.mocked(openModel).mockRejectedValueOnce(cancellation);
  else vi.mocked(inspectEngine).mockRejectedValueOnce(cancellation);
  await expect(modelReadiness(settings)).rejects.toBe(cancellation);
  expect(openModel).toHaveBeenCalledTimes(1);
});
it('propagates an aborted caller signal instead of returning partial readiness', async () => {
  const controller = new AbortController(); const failure = new Error('Probe interrupted');
  vi.mocked(openModel).mockImplementationOnce(async () => { controller.abort(); throw failure; });
  await expect(modelReadiness(settings, { signal: controller.signal })).rejects.toBe(failure);
  expect(openModel).toHaveBeenCalledTimes(1); expect(inspectEngine).not.toHaveBeenCalled();
});
it('does no probes for a pre-cancelled caller', async () => {
  await expect(modelReadiness(settings, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(openModel).not.toHaveBeenCalled(); expect(inspectEngine).not.toHaveBeenCalled();
});
