import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createImageClient } from 'picpatchsdk';

vi.mock('picpatchsdk', () => ({ createImageClient: vi.fn() }));
const originalArgv = process.argv;
let directory: string | undefined;
afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('allows two hours for each inference call, retaining progress and disposal', async () => {
  directory = await mkdtemp(join(tmpdir(), 'picpatch-base-example-'));
  const configuration = join(directory, 'configuration.json');
  await writeFile(configuration, JSON.stringify({ timeouts: { startupMs: 1234 } }));
  process.argv = ['node', 'klein-base.ts', configuration, join(directory, 'output')];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const generatedPath = join(directory, 'generated.png');
  const client = {
    plan: vi.fn(),
    generate: vi.fn().mockResolvedValue({ status: 'completed', image: { path: generatedPath } }),
    edit: vi.fn().mockResolvedValue({ status: 'completed', image: { path: join(directory, 'edited.png') } }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(createImageClient).mockReturnValue(client);
  await import('../../examples/klein-base.ts');
  expect(createImageClient).toHaveBeenCalledWith({ timeouts: { startupMs: 1234 } });
  expect(client.generate).toHaveBeenCalledOnce(); expect(client.edit).toHaveBeenCalledOnce();
  expect(client.generate.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 7_200_000, onProgress: expect.any(Function) });
  expect(client.edit.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 7_200_000, onProgress: expect.any(Function) });
  expect(client.edit.mock.calls[0]?.[0]).toMatchObject({ sourceImage: generatedPath });
  expect(client.dispose).toHaveBeenCalledOnce();
});
