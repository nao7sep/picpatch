import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createEditor, PicPatchUsageError, type EditResult } from 'picpatch';
import { compare, type ComparisonRecord } from '../../benchmarks/comparison.ts';
vi.mock('picpatch', async original => ({ ...await original<typeof import('picpatch')>(), createEditor: vi.fn() }));
const directories: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function reportPath() { const dir = await mkdtemp(join(tmpdir(), 'picpatch-comparison-')); directories.push(dir); return join(dir, 'report.jsonl'); }
async function records(path: string): Promise<ComparisonRecord[]> { return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
const result: EditResult = { model: 'test', modelRevision: 'revision', runtime: { name: 'mflux', version: 'test' }, seed: 1, effectiveParameters: { steps: 2, negativePrompt: 'private words' }, image: { path: '/private/output.png', mimeType: 'image/png', size: { width: 16, height: 16 } }, references: [], sidecar: { status: 'saved', path: '/private/output.png.json' } };
it('persists success, skips unsupported and dependent cases, and recreates a failed session', async () => {
  const path = await reportPath();
  const first = { generate: vi.fn().mockResolvedValue(result), edit: vi.fn().mockRejectedValue(new PicPatchUsageError('UNSUPPORTED_CAPABILITY', 'private details')), dispose: vi.fn().mockResolvedValue(undefined) };
  const next = { generate: vi.fn().mockResolvedValue(result), edit: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(createEditor).mockReturnValueOnce(first).mockReturnValueOnce(next);
  await compare([{ id: 'neutral', options: {}, operations: [
    { operation: 'generate', request: { prompt: 'private prompt' } },
    { operation: 'edit', sourceFromPrevious: true, request: { instruction: 'private edit' } },
    { operation: 'edit', sourceFromPrevious: true, request: { instruction: 'dependent' } },
    { operation: 'generate', request: { prompt: 'independent' } },
  ] }], path);
  const rows = await records(path);
  expect(rows.map(row => row.outcome)).toEqual(['completed', 'unsupported', 'untested', 'completed']);
  expect(first.edit.mock.calls[0]![0].sourceImage).toBe(result.image.path);
  expect(first.dispose).toHaveBeenCalledOnce(); expect(next.dispose).toHaveBeenCalledOnce();
  expect(await readFile(path, 'utf8')).not.toContain('private');
  expect(rows[0]).toMatchObject({ image: 'output.png', sidecar: 'output.png.json', parameters: { steps: 2 }, memory: 'not-measured' });
  await expect(compare([], path)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await records(path)).toEqual(rows);
});
it('marks cancelled remainder untested without starting editors', async () => {
  const path = await reportPath();
  await compare([{ id: 'cancelled', options: {}, operations: [{ operation: 'generate', request: { prompt: 'neutral' } }] }], path, AbortSignal.abort());
  expect((await records(path))[0]!.outcome).toBe('untested'); expect(createEditor).not.toHaveBeenCalled();
});
it('records the failure but stops when disposal cannot establish settlement', async () => {
  const path = await reportPath(); const failure = new Error('unsettled');
  vi.mocked(createEditor).mockReturnValue({ generate: vi.fn().mockRejectedValue(new Error('failed')), edit: vi.fn(), dispose: vi.fn().mockRejectedValue(failure) });
  await expect(compare([{ id: 'failure', options: {}, operations: [{ operation: 'generate', request: { prompt: 'neutral' } }, { operation: 'generate', request: { prompt: 'another' } }] }], path)).rejects.toBe(failure);
  expect((await records(path)).map(row => row.outcome)).toEqual(['failed']);
});

it('reports actual SDK stages without serializing progress messages', async () => {
  const path = await reportPath(); const events: Record<string, unknown>[] = [];
  vi.mocked(createEditor).mockReturnValue({ generate: async (_request, options) => {
    for (const stage of ['loading', 'loading', 'generating', 'saving'] as const) options?.onProgress?.({ type: 'progress', verb: 'generate', stage, message: 'private text' });
    return result;
  }, edit: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) });
  await compare([{ id: 'stages', options: {}, operations: [{ operation: 'generate', request: { prompt: 'private' } }] }], path, undefined, event => events.push(event));
  expect(events.filter(event => event.kind === 'phase').map(event => event.stage)).toEqual(['loading', 'generating', 'saving']);
  expect(JSON.stringify(events)).not.toContain('private');
});
