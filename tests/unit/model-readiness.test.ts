import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('picpatchsdk', () => ({ listModels: vi.fn(), openModel: vi.fn(), inspectEngine: vi.fn(), inspectNativeEngine: vi.fn() }));
import { listModels, openModel, inspectEngine, inspectNativeEngine } from 'picpatchsdk';
import { modelReadiness } from '../../src/main/core/model-readiness.ts';
const settings = { version: 1 as const, profile: { version: 1 as const }, registrations: {} };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listModels).mockReturnValue([{ id: 'a', acquisition: 'pinned', runtime: { name: 'mflux' } }, { id: 'b', acquisition: 'pinned', runtime: { name: 'mflux' } }, { id: 'external', acquisition: 'local', runtime: { name: 'stable-diffusion.cpp' } }] as never);
});
it('checks existing files and shares cheap engine inspection without loading models', async () => {
  vi.mocked(openModel).mockResolvedValue({ status: 'present' } as never);
  vi.mocked(inspectEngine).mockResolvedValue({ status: 'ready' } as never);
  expect(await modelReadiness(settings)).toEqual({ a: 'ready', b: 'ready', external: 'missing' });
  expect(inspectEngine).toHaveBeenCalledTimes(1); expect(openModel).toHaveBeenCalledTimes(2); expect(inspectNativeEngine).not.toHaveBeenCalled();
});
it('distinguishes missing weights and missing engines', async () => {
  vi.mocked(openModel).mockResolvedValueOnce({ status: 'refused' } as never).mockResolvedValueOnce({ status: 'present' } as never);
  vi.mocked(inspectEngine).mockResolvedValue({ status: 'missing' } as never);
  expect(await modelReadiness(settings)).toEqual({ a: 'missing', b: 'engineMissing', external: 'missing' });
});
