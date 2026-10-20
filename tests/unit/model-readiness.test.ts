import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('picpatchsdk', () => ({ listModels: vi.fn(), openModel: vi.fn(), inspectEngine: vi.fn(), inspectNativeEngine: vi.fn() }));
import { listModels, openModel, inspectEngine, inspectNativeEngine } from 'picpatchsdk';
import { modelReadiness } from '../../src/main/core/model-readiness.ts';
const settings = { version: 1 as const, profile: { version: 1 as const }, registrations: {} };
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
