import { isDeepStrictEqual } from 'node:util';
import { errorNotice, UiError, type Message } from '../../shared/i18n/index.ts';
import { recoverCommand } from '../../shared/image-command.ts';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, realpath, lstat } from 'node:fs/promises';
import { join, basename, isAbsolute, relative, sep } from 'node:path';
import { validateArtifactRecord } from 'picpatchsdk';
import sharp from 'sharp';
import { controlKinds, initialDraft } from '../../shared/session.ts';
import type { Session, SessionSummary, Draft, Asset } from '../../shared/session.ts';
import { writeJson } from './files.ts';
import { appFile, checkBeforeWrite, checkFileHeader, fileContent } from './file-header.ts';
import { refused } from './refused-files.ts';

const removing = /^[a-f0-9-]{36}\.removing-[a-f0-9-]{36}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Whether a path exists; any failure other than its absence is thrown. */
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !uuid.test(value)) throw new UiError('error.invalid_session_or_asset_identifier'); }
export function validateDraft(value: unknown): Draft {
  const draft = value as Draft;
  if (!draft || !['generate', 'edit'].includes(draft.mode) || typeof draft.text !== 'string' || !Array.isArray(draft.modelIds) || !draft.modelIds.every(v => typeof v === 'string' && v.length) || !Number.isSafeInteger(draft.width) || draft.width < 1 || !Number.isSafeInteger(draft.height) || draft.height < 1 || !draft.parameters || typeof draft.parameters !== 'object' || Array.isArray(draft.parameters) || !Array.isArray(draft.references)) throw new UiError('error.invalid_session_draft');
  // The same ranges the options pane accepts; a value outside them is refused, never corrected.
  if (draft.seed !== undefined && (!Number.isSafeInteger(draft.seed) || draft.seed < 0 || draft.seed > 2 ** 32 - 1)) throw new UiError('error.invalid_seed');
  if (draft.outpaint !== undefined && (!draft.outpaint || [draft.outpaint.width, draft.outpaint.height].some(value => !Number.isSafeInteger(value) || value < 1) || [draft.outpaint.left, draft.outpaint.top].some(value => !Number.isSafeInteger(value) || value < 0))) throw new UiError('error.invalid_session_draft');
  for (const asset of [draft.source, draft.mask, draft.control?.image]) if (asset !== undefined) id(asset);
  for (const group of draft.references) {
    if (!group || typeof group.id !== 'string' || !Array.isArray(group.images)) throw new UiError('error.invalid_reference_group');
    group.images.forEach(id);
  }
  if (draft.control && (!(controlKinds as readonly string[]).includes(draft.control.kind) || (draft.control.strength !== undefined && (!Number.isFinite(draft.control.strength) || draft.control.strength < 0)))) throw new UiError('error.invalid_structural_control');
  return structuredClone(draft);
}
/** A session the listing could not show, or a cleanup it could not finish, with the notice that names its file. */
export interface SessionFailure { id: string; message: string; notice: Message }
const failure = (id: string, error: unknown): SessionFailure => ({ id, message: error instanceof Error ? error.message : 'Could not read session.', notice: errorNotice(error, 'error.invalid_session') });
export function validateSession(value: unknown): Session {
  const session = value as Session;
  if (!session || typeof session !== 'object') throw new UiError('error.invalid_session');
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
    // A record a newer PicPatch wrote is refused, not thrown: the session opens, and only that image's Save is refused.
    if (run.record) validateArtifactRecord(run.record);
    if (run.status === 'completed' && (!run.output || !run.record)) throw new UiError('error.incomplete_saved_result');
  }
  for (const run of session.runs) if (run.parent !== undefined && (!runs.has(run.parent) || run.parent === run.id)) throw new Error('Invalid parent image.');
  const check = (draft: Draft) => { for (const key of [draft.source, draft.mask, draft.control?.image, ...draft.references.flatMap(group => group.images)]) if (key !== undefined && !ids.has(key) && !runs.has(key)) throw new UiError('error.session_references_a_missing_image'); };
  check(session.draft); session.runs.forEach(run => check(run.draft));
  return structuredClone(session);
}
/** cover is the latest completed result. */
function summarize(session: Session): SessionSummary {
  let results = 0, cover: string | undefined;
  for (const run of session.runs) if (run.status === 'completed' && run.output) { results++; cover = run.id; }
  return { id: session.id, name: session.name, updated: session.updated, results, ...(cover ? { cover } : {}) };
}
/** Only files the image decoder recognises join a session; the check reads the header of the private copy. */
async function checkImage(path: string): Promise<void> {
  try { const { width, height } = await sharp(path, { limitInputPixels: false }).metadata(); if (!width || !height) throw new Error('No image size.'); }
  catch { throw new UiError('error.select_a_regular_image_file'); }
}
/** Single GUI process owns this collection; outside concurrent editing is not supported. */
export class Sessions {
  readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  /** Full sessions the user opened or work touched; the collection listing keeps only summaries. */
  private loaded = new Map<string, Session>();
  private focused?: string;
  private pins = new Map<string, number>();
  focus(key?: string) { this.focused = key; this.evict(); }
  pin(key: string): () => void { this.pins.set(key, (this.pins.get(key) ?? 0) + 1); return () => { const n = this.pins.get(key)! - 1; if (n) this.pins.set(key, n); else this.pins.delete(key); this.evict(); }; }
  private evict() { for (const key of this.loaded.keys()) if (key !== this.focused && !this.pins.has(key)) this.loaded.delete(key); }
  private summaries = new Map<string, SessionSummary>();
  /** Removal folders a previous launch could not delete, reported in every listing. */
  private leftovers: SessionFailure[] = [];
  /** `idle` says no run is going, asked again before each run folder the opening sweep removes. */
  constructor(root: string, private saved: (path: string, bytes: Buffer) => void = () => {}, private existingCollection = false, private idle: () => boolean = () => true) {
    if (!isAbsolute(root)) throw new UiError('error.session_collection_must_be_absolute');
    this.root = root;
    // Swept once, first in the chain, so no removal or run of this collection can be under way.
    this.tail = this.sweep();
  }
  private async sweep(): Promise<void> {
    let entries;
    // An unreadable collection is reported by listing it.
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (uuid.test(entry.name)) { await this.sweepScratch(entry.name); continue; }
      if (!removing.test(entry.name)) continue;
      try { await rm(join(this.root, entry.name), { recursive: true, force: true }); }
      catch (error) { this.leftovers.push(failure(entry.name, new UiError('ui.session_cleanup_pending', { path: join(this.root, entry.name) }, { cause: error }))); }
    }
  }
  /**
   * A run's private folder (`.picpatch-*` beside its output) is left behind when the app quit mid-run. No run of this
   * collection should be going while it opens, but the collection may be the open one chosen again, so idleness is
   * asked before each removal; once work has started, the rest wait for the next opening. A folder holding a finished
   * image is the recovery folder a failed save named, and stays. One that cannot be removed is reported in every
   * listing and tried again at the next opening.
   */
  private async sweepScratch(session: string): Promise<void> {
    const outputs = join(this.root, session, 'outputs');
    let entries;
    try { entries = await readdir(outputs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('.picpatch-')) continue;
      const folder = join(outputs, entry.name);
      try {
        if (await exists(join(folder, 'complete.png'))) continue;
        if (!this.idle()) return;
        await rm(folder, { recursive: true, force: true });
      } catch (error) { this.leftovers.push(failure(session, new UiError('ui.run_files_cleanup_pending', { path: folder }, { cause: error }))); }
    }
  }
  directory(key: string): string { id(key); return join(this.root, key); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => {}); return next; }
  /** A chosen collection that is missing (an unplugged drive) is reported, never recreated. */
  list(): Promise<{ sessions: SessionSummary[]; failures: SessionFailure[]; unavailable?: { path: string; code?: string } }> {
    return this.serial(() => this.listing());
  }
  private async listing(): Promise<{ sessions: SessionSummary[]; failures: SessionFailure[]; unavailable?: { path: string; code?: string } }> {
    if (!this.existingCollection) await mkdir(this.root, { recursive: true, mode: 0o700 });
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (!this.existingCollection) throw error; const code = (error as { code?: unknown }).code; return { sessions: [], failures: [], unavailable: { path: this.root, ...(typeof code === 'string' ? { code } : {}) } }; }
    const sessions: SessionSummary[] = [], failures = [...this.leftovers];
    for (const entry of entries) {
      if (!uuid.test(entry.name) || !entry.isDirectory()) continue;
      try {
        let summary = this.summaries.get(entry.name);
        if (!summary) { summary = summarize(this.loaded.get(entry.name) ?? await this.parse(entry.name)); this.summaries.set(entry.name, summary); }
        sessions.push(summary);
      } catch (error) { failures.push(failure(entry.name, error)); }
    }
    return { sessions: sessions.sort((a, b) => b.updated.localeCompare(a.updated)), failures };
  }
  /** Reads take the chain's turn, so no save can finish during one. */
  get(key: string): Promise<Session> { return this.serial(async () => structuredClone(await this.read(key))); }
  /** A session as saved, read and checked, without caching it. */
  private async parse(key: string): Promise<Session> {
    const directory = this.directory(key);
    if ((await lstat(directory)).isSymbolicLink()) throw new UiError('error.linked_sessions_are_not_supported');
    // A session.json that is newer, or that cannot be read, is refused alone by its path and left as it is.
    const path = join(directory, 'session.json');
    let document: unknown;
    try { document = JSON.parse(await readFile(path, 'utf8')); } catch (error) { throw refused(path, false, error); }
    const header = checkFileHeader(document, 'session');
    if (header.status !== 'current') throw refused(path, header.status === 'newer');
    let session: Session;
    try { session = validateSession(fileContent(document as object)); } catch (error) { throw refused(path, false, error); }
    if (session.id !== key) throw new UiError('error.session_identity_does_not_match_its_directory');
    return session;
  }
  /** The cached session itself, read in the chain's turn; callers only read it. */
  private async read(key: string): Promise<Session> {
    id(key);
    const cached = this.loaded.get(key); if (cached) return cached;
    const session = await this.parse(key);
    // Reopening never schedules inference. Queued work requires an explicit resume.
    for (const run of session.runs) if (run.status === 'running') { run.status = 'interrupted'; run.issue = { code: 'INTERRUPTED', effect: 'unknown' }; }
    session.draft = recoverCommand(session.draft, session.runs);
    this.loaded.set(key, session); return session;
  }
  async create(name = 'Untitled session', draft = initialDraft()): Promise<Session> {
    return this.serial(async () => {
      const key = randomUUID(); const now = new Date().toISOString();
      const session: Session = { id: key, name, created: now, updated: now, draft: validateDraft(draft), assets: [], runs: [] };
      await mkdir(join(this.directory(key), 'assets'), { recursive: true, mode: 0o700 });
      await mkdir(join(this.directory(key), 'outputs'), { mode: 0o700 });
      await this.publish(session); return structuredClone(session);
    });
  }
  private async publish(session: Session, historyChanged = true): Promise<void> {
    const valid = session;
    const path = join(this.directory(session.id), 'session.json');
    // Guarded at the write: a session.json replaced since it was read (by a newer PicPatch, say) is never saved over.
    await checkBeforeWrite(path, 'session');
    const bytes = await writeJson(path, appFile('session', valid));
    this.loaded.set(session.id, valid);
    if (historyChanged || !this.summaries.has(session.id)) this.summaries.set(session.id, summarize(valid));
    try { this.saved(path, bytes); } catch { /* Backup history cannot fail a primary save. */ }
  }
  /**
   * Saves a change. As in a chat list, only `submitted`, a command the user sent, moves the session's updated time and
   * so brings it to the top of the collection; the run's result keeps it there, and edits, imports, masks, renames and
   * run-status changes keep its place.
   */
  update(key: string, change: (session: Session) => void, submitted = false): Promise<Session> {
    return this.serial(async () => {
      const session = structuredClone(await this.read(key)); const before = JSON.stringify(session); change(session);
      // A change that alters nothing is not written and does not reorder the collection.
      if (JSON.stringify(session) === before) return session;
      if (submitted) session.updated = new Date().toISOString();
      const valid = validateSession(session);
      await this.publish(valid); this.evict(); return session;
    });
  }
  saveDraft(key: string, draft: Draft): Promise<void> {
    return this.serial(async () => {
      const session = await this.read(key);
      if (isDeepStrictEqual(session.draft, draft)) return;
      const valid = validateDraft(draft);
      for (const ref of [valid.source, valid.mask, valid.control?.image, ...valid.references.flatMap(group => group.images)]) if (ref !== undefined && !session.assets.some(asset => asset.id === ref) && !session.runs.some(run => run.id === ref)) throw new UiError('error.session_references_a_missing_image');
      await this.publish({ ...session, draft: valid }, false); this.evict();
    });
  }
  async imagePath(key: string, assetId: string): Promise<string> {
    const session = this.loaded.get(key) ?? await this.parse(key); id(assetId);
    const file = session.assets.find(a => a.id === assetId)?.file ?? session.runs.find(r => r.id === assetId)?.output;
    if (!file) throw new UiError('error.image_is_not_part_of_this_session');
    const directory = await realpath(this.directory(key)); const path = await realpath(join(directory, file)); const part = relative(directory, path);
    if (part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) throw new UiError('error.image_escapes_its_session');
    return path;
  }
  importImage(key: string, source: string): Promise<Asset> { const release = this.pin(key); return this.copyImage(key, source).finally(release); }
  private async copyImage(key: string, source: string): Promise<Asset> {
    if (!isAbsolute(source)) throw new UiError('error.select_an_absolute_image_path');
    await this.get(key);
    const assetId = randomUUID(); const file = `assets/${assetId}`; const path = join(this.directory(key), file); const temporary = `${path}.tmp`;
    const input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    let asset: Asset;
    try {
      const before = await input.stat({ bigint: true }); if (!before.isFile()) throw new UiError('error.select_a_regular_image_file');
      const output = await open(temporary, 'wx', 0o600); const hash = createHash('sha256'); let bytes = 0;
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) { const chunk = await input.read(buffer, 0, buffer.length, bytes); if (!chunk.bytesRead) break; const data = buffer.subarray(0, chunk.bytesRead); hash.update(data); await output.writeFile(data); bytes += chunk.bytesRead; }
        // Preserve metadata before the final durability flush.
        await output.utimes(Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
        await output.sync();
      } finally { await output.close(); }
      await checkImage(temporary);
      // A copy keeps the original's modified time.
      await rename(temporary, path);
      asset = { id: assetId, name: basename(source), file, bytes, sha256: hash.digest('hex') };
    } finally { await input.close(); await rm(temporary, { force: true }); }
    // A failed metadata save leaves the copied image intact for inspection.
    await this.update(key, session => { session.assets.push(asset); });
    return asset;
  }
  /** An image the app made, such as a painted mask, joins the session from memory, checked like an import. */
  addImage(key: string, name: string, bytes: Uint8Array): Promise<Asset> { const release = this.pin(key); return this.writeImage(key, name, bytes).finally(release); }
  private async writeImage(key: string, name: string, bytes: Uint8Array): Promise<Asset> {
    await this.get(key);
    const assetId = randomUUID(); const file = `assets/${assetId}`; const path = join(this.directory(key), file); const temporary = `${path}.tmp`;
    try {
      const output = await open(temporary, 'wx', 0o600);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      await checkImage(temporary);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    const asset: Asset = { id: assetId, name, file, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    // A failed metadata save leaves the image intact for inspection.
    await this.update(key, session => { session.assets.push(asset); });
    return asset;
  }
  /** Removal hides the session at once; deleting its uniquely named folder runs outside the chain, and the next launch's sweep retries a leftover. */
  async remove(key: string): Promise<{ cleanup?: import('../../shared/i18n/index.ts').Message }> {
    const hidden = await this.serial(async () => {
      await this.read(key); const hidden = join(this.root, `${key}.removing-${randomUUID()}`);
      await rename(this.directory(key), hidden); this.loaded.delete(key); this.summaries.delete(key); return hidden;
    });
    try { await rm(hidden, { recursive: true, force: true }); } catch { return { cleanup: { key: 'ui.session_cleanup_pending', values: { path: hidden } } }; }
    return {};
  }
  async settled(): Promise<void> { await this.tail; }
}
