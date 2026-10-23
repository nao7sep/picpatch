import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Sessions } from '../../src/main/core/sessions.ts';
import { PendingResults } from '../../src/main/core/pending-results.ts';
import type { ArtifactRecord } from 'picpatchsdk';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-pending-')); roots.push(root);
  const sessions = new Sessions(root); const session = await sessions.create(); const runId = randomUUID();
  await sessions.update(session.id, value => { value.runs.push({ id: runId, modelId: 'fixture', seed: 42, draft: session.draft, status: 'running', created: session.created }); });
  const staged = await sessions.stagedOutput(session.id, runId);
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'red' } }).png().toBuffer();
  await writeFile(staged, bytes);
  const record: ArtifactRecord = JSON.parse(await readFile(new URL('../fixtures/artifact.json', import.meta.url), 'utf8'));
  record.image = { filename: `${runId}.png`, mimeType: 'image/png', size: { width: 2, height: 3 } };
  record.seed = 42; record.sha256 = createHash('sha256').update(bytes).digest('hex'); record.bytes = bytes.length;
  return { root, sessions, session, runId, staged, bytes, record, evidence: join(root, session.id, 'outputs', '.pending', `${runId}.json`) };
}
it('recovers exact completion after publication before the session commit without inference replay', async () => {
  const f = await fixture(); await f.sessions.completeOutput(f.session.id, f.runId, f.record);
  const disk = JSON.parse(await readFile(join(f.root, f.session.id, 'session.json'), 'utf8'));
  expect(disk.runs[0].status).toBe('running');
  const reopened = await new Sessions(f.root).get(f.session.id);
  expect(reopened.runs[0]).toMatchObject({ status: 'completed', record: f.record, output: `outputs/${f.runId}.png` });
  expect(await readFile(join(f.root, f.session.id, 'outputs', `${f.runId}.png`))).toEqual(f.bytes);
  expect((await new Sessions(f.root).get(f.session.id)).runs[0]).toEqual(reopened.runs[0]);
});
it('recovers a durable completion record whose image has not yet received its final name', async () => {
  const f = await fixture();
  await writeFile(f.evidence, JSON.stringify({ version: 1, sessionId: f.session.id, runId: f.runId, record: f.record }));
  const reopened = await new Sessions(f.root).get(f.session.id);
  expect(reopened.runs[0]?.status).toBe('completed');
  await expect(readFile(f.staged)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('refuses corrupt completion evidence and preserves unexpected final output', async () => {
  const f = await fixture(); const final = join(f.root, f.session.id, 'outputs', `${f.runId}.png`);
  await writeFile(final, 'unrelated');
  await expect(f.sessions.completeOutput(f.session.id, f.runId, f.record)).rejects.toThrow('match');
  expect(await readFile(final, 'utf8')).toBe('unrelated'); expect(await readFile(f.staged)).toEqual(f.bytes);
  await expect(new Sessions(f.root).get(f.session.id)).rejects.toThrow('match');
  await writeFile(f.evidence, JSON.stringify({ version: 2 }));
  await expect(new Sessions(f.root).get(f.session.id)).rejects.toThrow('Invalid pending');
});
it('retires evidence only after the manifest contains the exact completed result', async () => {
  const f = await fixture(); await f.sessions.completeOutput(f.session.id, f.runId, f.record);
  const reopened = new Sessions(f.root);
  await reopened.update(f.session.id, value => { value.name = 'Recovered'; });
  await reopened.retireOutput(f.session.id, f.runId);
  expect((await new Sessions(f.root).get(f.session.id)).runs[0]).toMatchObject({ status: 'completed', record: f.record });
  await expect(readFile(f.evidence)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = new PendingResults(key => join(f.root, key));
  await expect(result.retire(f.session.id, f.runId)).resolves.toBeUndefined();
});
