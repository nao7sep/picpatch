import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, realpath, lstat } from 'node:fs/promises';
import { join, basename, isAbsolute, relative, sep } from 'node:path';
import { validateArtifactRecord } from 'picpatchsdk';
import { initialDraft } from './types.ts';
import type { Session, SessionSummary, Draft, Asset } from './types.ts';
import { writeJson } from './files.ts';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid session or asset identifier.'); }
export function validateDraft(value: unknown): Draft {
  const draft = value as Draft;
  if (!draft || !['generate', 'edit'].includes(draft.mode) || typeof draft.text !== 'string' || !Array.isArray(draft.modelIds) || !draft.modelIds.every(v => typeof v === 'string' && v.length) || !Number.isSafeInteger(draft.width) || draft.width < 1 || !Number.isSafeInteger(draft.height) || draft.height < 1 || !draft.parameters || typeof draft.parameters !== 'object' || Array.isArray(draft.parameters) || !Array.isArray(draft.references)) throw new Error('Invalid session draft.');
  if (draft.seed !== undefined && (!Number.isSafeInteger(draft.seed) || draft.seed < 0)) throw new Error('Invalid seed.');
  for (const asset of [draft.source, draft.mask]) if (asset !== undefined) id(asset);
  for (const group of draft.references) {
    if (!group || typeof group.id !== 'string' || !Array.isArray(group.images)) throw new Error('Invalid reference group.');
    group.images.forEach(id);
  }
  return structuredClone(draft);
}
export function validateSession(value: unknown): Session {
  const session = value as Session;
  if (!session || session.version !== 1) throw new Error('Unsupported session format; the file was preserved.');
  id(session.id);
  if (typeof session.name !== 'string' || !Number.isFinite(Date.parse(session.created)) || !Number.isFinite(Date.parse(session.updated)) || !Array.isArray(session.assets) || !Array.isArray(session.runs)) throw new Error('Invalid session.');
  validateDraft(session.draft);
  const ids = new Set<string>();
  for (const asset of session.assets) {
    id(asset.id);
    if (ids.has(asset.id) || asset.file !== `assets/${asset.id}` || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid session asset.');
    ids.add(asset.id);
  }
  const runs = new Set<string>();
  for (const run of session.runs) {
    id(run.id); validateDraft(run.draft);
    if (runs.has(run.id) || !['queued', 'running', 'completed', 'refused', 'failed', 'cancelled', 'interrupted'].includes(run.status) || typeof run.modelId !== 'string' || !Number.isSafeInteger(run.seed) || run.seed < 0) throw new Error('Invalid session attempt.');
    runs.add(run.id);
    if (run.output !== undefined && run.output !== `outputs/${run.id}.png`) throw new Error('Invalid result path.');
    if (run.record) validateArtifactRecord(run.record);
    if (run.status === 'completed' && (!run.output || !run.record)) throw new Error('Incomplete saved result.');
  }
  const check = (draft: Draft) => { for (const key of [draft.source, draft.mask, ...draft.references.flatMap(group => group.images)]) if (key !== undefined && !ids.has(key) && !runs.has(key)) throw new Error('Session references a missing image.'); };
  check(session.draft); session.runs.forEach(run => check(run.draft));
  return structuredClone(session);
}
/** Single GUI process owns this collection; outside concurrent editing is not supported. */
export class Sessions {
  readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = new Map<string, Session>();
  constructor(root: string, private saved: (path: string, bytes: Buffer) => void = () => {}, private existingCollection = false) {
    if (!isAbsolute(root)) throw new Error('Session collection must be absolute.');
    this.root = root;
  }
  directory(key: string): string { id(key); return join(this.root, key); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => {}); return next; }
  async list(): Promise<{ sessions: SessionSummary[]; failures: { id: string; message: string }[] }> {
    if (!this.existingCollection) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const sessions: SessionSummary[] = [], failures: { id: string; message: string }[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!uuid.test(entry.name) || !entry.isDirectory()) continue;
      try { const s = await this.get(entry.name); sessions.push({ id: s.id, name: s.name, updated: s.updated, results: s.runs.filter(r => r.status === 'completed').length }); }
      catch (error) { failures.push({ id: entry.name, message: error instanceof Error ? error.message : 'Could not read session.' }); }
    }
    return { sessions: sessions.sort((a, b) => b.updated.localeCompare(a.updated)), failures };
  }
  async get(key: string): Promise<Session> {
    id(key);
    const cached = this.loaded.get(key); if (cached) return structuredClone(cached);
    const directory = this.directory(key);
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked sessions are not supported.');
    const session = validateSession(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')));
    if (session.id !== key) throw new Error('Session identity does not match its directory.');
    // Reopening never schedules inference. Queued work requires an explicit resume.
    for (const run of session.runs) if (run.status === 'running') { run.status = 'interrupted'; run.issue = { code: 'INTERRUPTED', message: 'The app closed before this attempt settled.', effect: 'unknown' }; }
    this.loaded.set(key, session); return structuredClone(session);
  }
  async create(name = 'Untitled session'): Promise<Session> {
    return this.serial(async () => {
      const key = randomUUID(); const now = new Date().toISOString();
      const session: Session = { version: 1, id: key, name, created: now, updated: now, draft: initialDraft(), assets: [], runs: [] };
      await mkdir(join(this.directory(key), 'assets'), { recursive: true, mode: 0o700 });
      await mkdir(join(this.directory(key), 'outputs'), { mode: 0o700 });
      await this.publish(session); return structuredClone(session);
    });
  }
  private async publish(session: Session): Promise<void> {
    validateSession(session);
    const path = join(this.directory(session.id), 'session.json');
    const bytes = await writeJson(path, session);
    this.loaded.set(session.id, structuredClone(session));
    try { this.saved(path, bytes); } catch { /* Backup history cannot fail a primary save. */ }
  }
  update(key: string, change: (session: Session) => void): Promise<Session> {
    return this.serial(async () => { const session = await this.get(key); change(session); session.updated = new Date().toISOString(); await this.publish(session); return structuredClone(session); });
  }
  async imagePath(key: string, assetId: string): Promise<string> {
    const session = await this.get(key); id(assetId);
    const file = session.assets.find(a => a.id === assetId)?.file ?? session.runs.find(r => r.id === assetId)?.output;
    if (!file) throw new Error('Image is not part of this session.');
    const directory = await realpath(this.directory(key)); const path = await realpath(join(directory, file)); const part = relative(directory, path);
    if (part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) throw new Error('Image escapes its session.');
    return path;
  }
  async importImage(key: string, source: string): Promise<Asset> {
    if (!isAbsolute(source)) throw new Error('Select an absolute image path.');
    await this.get(key);
    const assetId = randomUUID(); const file = `assets/${assetId}`; const path = join(this.directory(key), file); const temporary = `${path}.tmp`;
    const input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    let asset: Asset;
    try {
      const before = await input.stat({ bigint: true }); if (!before.isFile()) throw new Error('Select a regular image file.');
      const output = await open(temporary, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) { const chunk = await input.read(buffer, 0, buffer.length, bytes); if (!chunk.bytesRead) break; const data = buffer.subarray(0, chunk.bytesRead); hash.update(data); await output.writeFile(data); bytes += chunk.bytesRead; }
        await output.sync();
      } finally { await output.close(); }
      const after = await input.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Source image changed while copying.');
      await rename(temporary, path);
      asset = { id: assetId, name: basename(source), file, bytes, sha256: hash.digest('hex') };
    } finally { await input.close(); await rm(temporary, { force: true }); }
    // A failed metadata save leaves the copied image intact for inspection.
    await this.update(key, session => { session.assets.push(asset); });
    return asset;
  }
  remove(key: string): Promise<void> {
    return this.serial(async () => { await this.get(key); await rm(this.directory(key), { recursive: true }); this.loaded.delete(key); });
  }
  async settled(): Promise<void> { await this.tail; }
}
