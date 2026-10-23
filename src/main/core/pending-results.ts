import { mkdir, readdir, readFile, rename, rm, lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateArtifactRecord, type ArtifactRecord } from 'picpatchsdk';
import type { Session } from '../../shared/session.ts';
import { writeJson, syncDirectory } from './files.ts';

/** Exact completion evidence is durable before a generated image receives its public session name. */
export class PendingResults {
  constructor(private directory: (key: string) => string) {}
  async staged(key: string, runId: string): Promise<string> {
    const folder = join(this.directory(key), 'outputs', '.pending');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await syncDirectory(join(this.directory(key), 'outputs'));
    return join(folder, `${runId}.png`);
  }
  private evidence(key: string, runId: string) { return join(this.directory(key), 'outputs', '.pending', `${runId}.json`); }
  async publish(key: string, runId: string, record: ArtifactRecord): Promise<void> {
    validateArtifactRecord(record);
    await writeJson(this.evidence(key, runId), { version: 1, sessionId: key, runId, record });
    await syncDirectory(join(this.directory(key), 'outputs', '.pending'));
    await this.finish(key, runId, record);
  }
  private async matches(path: string, record: ArtifactRecord): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== record.bytes) throw new Error('Pending image does not match its completion record.');
    const file = await open(path, 'r');
    try {
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== record.sha256) throw new Error('Pending image does not match its completion record.');
    } finally { await file.close(); }
  }
  private async finish(key: string, runId: string, record: ArtifactRecord): Promise<void> {
    const folder = join(this.directory(key), 'outputs');
    const final = join(folder, `${runId}.png`), staged = join(folder, '.pending', `${runId}.png`);
    let exists = true;
    try { await lstat(final); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
    if (exists) await this.matches(final, record);
    else { await this.matches(staged, record); try { await rename(staged, final); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.matches(final, record); } }
    if (process.platform !== 'win32') { await syncDirectory(folder); await syncDirectory(join(folder, '.pending')); }
  }
  async recover(session: Session): Promise<boolean> {
    let changed = false;
    let entries: string[];
    try { entries = await readdir(join(this.directory(session.id), 'outputs', '.pending')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    const runs = new Map(session.runs.map(run => [run.id, run]));
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const run = runs.get(entry.slice(0, -5));
      if (!run) throw new Error('Pending image completion has no matching attempt.');
      let text: string;
      try { text = await readFile(this.evidence(session.id, run.id), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const value = JSON.parse(text);
      if (value?.version !== 1 || value.sessionId !== session.id || value.runId !== run.id) throw new Error('Invalid pending image completion.');
      const checked = validateArtifactRecord(value.record);
      if (checked.status === 'refused') throw new Error('Unsupported pending image record.');
      const record: ArtifactRecord = value.record;
      if (record.image.filename !== `${run.id}.png` || record.seed !== run.seed) throw new Error('Pending image record belongs to a different attempt.');
      await this.finish(session.id, run.id, record);
      if (run.status !== 'completed' || !run.record) { run.status = 'completed'; run.output = `outputs/${run.id}.png`; run.record = record; delete run.issue; changed = true; }
    }
    return changed;
  }
  async retire(key: string, runId: string): Promise<void> {
    await rm(this.evidence(key, runId), { force: true });
  }
}
