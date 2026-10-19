import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { ArtifactRecord } from 'picpatchsdk/types';
import { Application } from '../../src/main/core/service.ts';
it('exports through the SDK without prompts and preserves independently exported files after session deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-export-'));
  try {
    const diagnostics: { level: string; message: string; details: Record<string, unknown> }[] = [];
    const app = await Application.open({ root, sessions: join(root, 'sessions'), config: join(root, 'config.json'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') }, undefined, undefined, (level, message, details) => diagnostics.push({ level, message, details }));
    const session = await app.sessions.create(); const runId = randomUUID();
    // Opaque 1x1 PNG, deliberately supplied through the public artifact contract.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64');
    const record: ArtifactRecord = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
    record.bytes = png.length; record.sha256 = createHash('sha256').update(png).digest('hex'); record.image.filename = `${runId}.png`;
    await writeFile(join(root, 'sessions', session.id, 'outputs', `${runId}.png`), png);
    await app.sessions.update(session.id, s => { s.runs.push({ id: runId, modelId: 'fixture', seed: 42, draft: s.draft, created: s.created, status: 'completed', output: `outputs/${runId}.png`, record }); });
    const exports = join(root, 'exports'); await mkdir(exports);
    const result = await app.export(session.id, runId, join(exports, 'selected.png'), true, false);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'saved' });
    const saved = JSON.parse(await readFile(join(exports, 'selected-picpatchsdk.json'), 'utf8'));
    expect(saved.inputs).toBeUndefined(); expect(saved.effectiveParameters.negativePrompt).toBeUndefined();
    expect((await app.sessions.get(session.id)).runs[0]!.record!.inputs?.prompt).toBe('private prompt');
    expect(await app.export(session.id, runId, join(exports, 'selected.png'), false, false)).toMatchObject({ status: 'refused', code: 'OUTPUT_CONFLICT' });
    await writeFile(join(exports, 'partial-picpatchsdk.json'), 'existing sidecar');
    expect(await app.export(session.id, runId, join(exports, 'partial.png'), true, false)).toMatchObject({ status: 'saved', sidecar: { status: 'failed', code: 'OUTPUT_CONFLICT' } });
    expect(await readFile(join(exports, 'partial.png'))).toEqual(png);
    expect(diagnostics).toContainEqual(expect.objectContaining({ level: 'warn', details: expect.objectContaining({ sessionId: session.id, runId, sidecar: expect.objectContaining({ code: 'OUTPUT_CONFLICT' }) }) }));
    expect(diagnostics.filter(item => (item.details.event as { name?: string } | undefined)?.name === 'operation.started')).toHaveLength(3);
    expect(diagnostics).toContainEqual(expect.objectContaining({ details: expect.objectContaining({ event: expect.objectContaining({ name: 'operation.refused', refusal: { code: 'OUTPUT_CONFLICT', effect: 'none' } }) }) }));
    expect(await readFile(join(exports, 'partial-picpatchsdk.json'), 'utf8')).toBe('existing sidecar');
    await app.remove(session.id); expect(await readFile(join(exports, 'selected.png'))).toEqual(png);
  } finally { await rm(root, { recursive: true, force: true }); }
});
