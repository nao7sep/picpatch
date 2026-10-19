import { UiError } from '../../shared/i18n/index.ts';
import { recoverCommand } from '../../shared/image-command.ts';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, realpath, lstat, utimes } from 'node:fs/promises';
import { join, basename, isAbsolute, relative, sep } from 'node:path';
import { validateArtifactRecord } from 'picpatchsdk';
import sharp from 'sharp';
import { initialDraft } from '../../shared/session.ts';
import type { Session, SessionSummary, Draft, Asset } from '../../shared/session.ts';
import { writeJson } from './files.ts';

const removing = /^[a-f0-9-]{36}\.removing-[a-f0-9-]{36}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuid.test(value)) throw new UiError('error.invalid_session_or_asset_identifier'); }
export function validateDraft(value: unknown): Draft {
  const draft = value as Draft;
  if (!draft || !['generate', 'edit'].includes(draft.mode) || typeof draft.text !== 'string' || !Array.isArray(draft.modelIds) || !draft.modelIds.every(v => typeof v === 'string' && v.length) || !Number.isSafeInteger(draft.width) || draft.width < 1 || !Number.isSafeInteger(draft.height) || draft.height < 1 || !draft.parameters || typeof draft.parameters !== 'object' || Array.isArray(draft.parameters) || !Array.isArray(draft.references)) throw new UiError('error.invalid_session_draft');
  if (draft.seed !== undefined && (!Number.isSafeInteger(draft.seed) || draft.seed < 0)) throw new UiError('error.invalid_seed');
  for (const asset of [draft.source, draft.mask, draft.control?.image]) if (asset !== undefined) id(asset);
  for (const group of draft.references) {
    if (!group || typeof group.id !== 'string' || !Array.isArray(group.images)) throw new UiError('error.invalid_reference_group');
    group.images.forEach(id);
  }
  if (draft.control && (!['canny', 'depth', 'pose'].includes(draft.control.kind) || (draft.control.strength !== undefined && !Number.isFinite(draft.control.strength)))) throw new UiError('error.invalid_structural_control');
  return structuredClone(draft);
}
export function validateSession(value: unknown): Session {
  const session = value as Session;
  if (!session || session.version !== 1) throw new UiError('error.unsupported_session_format_the_file_was_preserved');
  id(session.id);
  if (typeof session.name !== 'string' || !Number.isFinite(Date.parse(session.created)) || !Number.isFinite(Date.parse(session.updated)) || !Array.isArray(session.assets) || !Array.isArray(session.runs)) throw new UiError('error.invalid_session');
  validateDraft(session.draft);
  const ids = new Set<string>();
  for (const asset of session.assets) {
    id(asset.id);
    if (ids.has(asset.id) || asset.file !== `assets/${asset.id}` || typeof asset.name !== 'string' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new UiError('error.invalid_session_asset');
    ids.add(asset.id);
  }
  const runs = new Set<string>();
  for (const run of session.runs) {
    id(run.id); validateDraft(run.draft);
    if (runs.has(run.id) || !['queued', 'running', 'completed', 'refused', 'failed', 'cancelled', 'interrupted'].includes(run.status) || typeof run.modelId !== 'string' || !Number.isSafeInteger(run.seed) || run.seed < 0) throw new UiError('error.invalid_session_attempt');
    runs.add(run.id);
    if (run.output !== undefined && run.output !== `outputs/${run.id}.png`) throw new UiError('error.invalid_result_path');
    if (run.record) validateArtifactRecord(run.record);
    if (run.status === 'completed' && (!run.output || !run.record)) throw new UiError('error.incomplete_saved_result');
  }
  for (const run of session.runs) if (run.parent !== undefined && (!runs.has(run.parent) || run.parent === run.id)) throw new Error('Invalid parent image.');
  const check = (draft: Draft) => { for (const key of [draft.source, draft.mask, draft.control?.image, ...draft.references.flatMap(group => group.images)]) if (key !== undefined && !ids.has(key) && !runs.has(key)) throw new UiError('error.session_references_a_missing_image'); };
  check(session.draft); session.runs.forEach(run => check(run.draft));
  return structuredClone(session);
}
/** Single GUI process owns this collection; outside concurrent editing is not supported. */
export class Sessions {
  readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = new Map<string, Session>();
  constructor(root: string, private saved: (path: string, bytes: Buffer) => void = () => {}, private existingCollection = false) {
    if (!isAbsolute(root)) throw new UiError('error.session_collection_must_be_absolute');
    this.root = root;
  }
  directory(key: string): string { id(key); return join(this.root, key); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => {}); return next; }
  /** A chosen collection that is missing (an unplugged drive) is reported, never recreated. */
  async list(): Promise<{ sessions: SessionSummary[]; failures: { id: string; message: string }[]; unavailable?: { path: string; code?: string } }> {
    if (!this.existingCollection) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (!this.existingCollection) throw error; const code = (error as { code?: unknown }).code; return { sessions: [], failures: [], unavailable: { path: this.root, ...(typeof code === 'string' ? { code } : {}) } }; }
    const sessions: SessionSummary[] = [], failures: { id: string; message: string }[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && removing.test(entry.name)) { void rm(join(this.root, entry.name), { recursive: true, force: true }).catch(() => {}); continue; }
      if (!uuid.test(entry.name) || !entry.isDirectory()) continue;
      try { const s = await this.read(entry.name); let results = 0, cover: string | undefined; for (const r of s.runs) if (r.status === 'completed' && r.output) { results++; cover = r.id; } sessions.push({ id: s.id, name: s.name, updated: s.updated, results, ...(cover ? { cover } : {}) }); }
      catch (error) { failures.push({ id: entry.name, message: error instanceof Error ? error.message : 'Could not read session.' }); }
    }
    return { sessions: sessions.sort((a, b) => b.updated.localeCompare(a.updated)), failures };
  }
  async get(key: string): Promise<Session> { return structuredClone(await this.read(key)); }
  /** The cached session itself; callers only read it. */
  private async read(key: string): Promise<Session> {
    id(key);
    const cached = this.loaded.get(key); if (cached) return cached;
    const directory = this.directory(key);
    if ((await lstat(directory)).isSymbolicLink()) throw new UiError('error.linked_sessions_are_not_supported');
    const session = validateSession(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')));
    if (session.id !== key) throw new UiError('error.session_identity_does_not_match_its_directory');
    // Reopening never schedules inference. Queued work requires an explicit resume.
    for (const run of session.runs) if (run.status === 'running') { run.status = 'interrupted'; run.issue = { code: 'INTERRUPTED', message: 'The app closed before this attempt settled.', effect: 'unknown' }; }
    delete (session as { selection?: unknown }).selection;
    session.draft = recoverCommand(session.draft, session.runs);
    // A save that finished during this read is newer than the file just read.
    const newer = this.loaded.get(key); if (newer) return newer;
    this.loaded.set(key, session); return session;
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
    const valid = validateSession(session);
    const path = join(this.directory(session.id), 'session.json');
    const bytes = await writeJson(path, valid);
    this.loaded.set(session.id, valid);
    try { this.saved(path, bytes); } catch { /* Backup history cannot fail a primary save. */ }
  }
  update(key: string, change: (session: Session) => void): Promise<Session> {
    return this.serial(async () => {
      const session = await this.get(key); const before = JSON.stringify(session); change(session);
      // A change that alters nothing is not written and does not reorder the collection.
      if (JSON.stringify(session) === before) return session;
      session.updated = new Date().toISOString(); await this.publish(session); return session;
    });
  }
  async imagePath(key: string, assetId: string): Promise<string> {
    const session = await this.read(key); id(assetId);
    const file = session.assets.find(a => a.id === assetId)?.file ?? session.runs.find(r => r.id === assetId)?.output;
    if (!file) throw new UiError('error.image_is_not_part_of_this_session');
    const directory = await realpath(this.directory(key)); const path = await realpath(join(directory, file)); const part = relative(directory, path);
    if (part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) throw new UiError('error.image_escapes_its_session');
    return path;
  }
  async importImage(key: string, source: string): Promise<Asset> {
    if (!isAbsolute(source)) throw new UiError('error.select_an_absolute_image_path');
    await this.read(key);
    const assetId = randomUUID(); const file = `assets/${assetId}`; const path = join(this.directory(key), file); const temporary = `${path}.tmp`;
    const input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    let asset: Asset;
    try {
      const before = await input.stat({ bigint: true }); if (!before.isFile()) throw new UiError('error.select_a_regular_image_file');
      const output = await open(temporary, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) { const chunk = await input.read(buffer, 0, buffer.length, bytes); if (!chunk.bytesRead) break; const data = buffer.subarray(0, chunk.bytesRead); hash.update(data); await output.writeFile(data); bytes += chunk.bytesRead; }
        await output.sync();
      } finally { await output.close(); }
      const after = await input.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new UiError('error.source_image_changed_while_copying');
      // Only files the image decoder recognises join the session; the check reads the header of the private copy.
      try { const { width, height } = await sharp(temporary, { limitInputPixels: false }).metadata(); if (!width || !height) throw new Error('No image size.'); }
      catch { throw new UiError('error.select_a_regular_image_file'); }
      // A copy keeps the original's modified time.
      await utimes(temporary, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
      await rename(temporary, path);
      asset = { id: assetId, name: basename(source), file, bytes, sha256: hash.digest('hex') };
    } finally { await input.close(); await rm(temporary, { force: true }); }
    // A failed metadata save leaves the copied image intact for inspection.
    await this.update(key, session => { session.assets.push(asset); });
    return asset;
  }
  /** Removal hides the session at once; deleting its files runs outside the save lock, and a later listing retries leftovers. */
  async remove(key: string): Promise<void> {
    const hidden = await this.serial(async () => {
      await this.read(key); const hidden = join(this.root, `${key}.removing-${randomUUID()}`);
      await rename(this.directory(key), hidden); this.loaded.delete(key); return hidden;
    });
    await rm(hidden, { recursive: true, force: true }).catch(() => {});
  }
  async settled(): Promise<void> { await this.tail; }
}
