import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { listModels, inspectModels, prepareModel, saveArtifact, validateProfile } from 'picpatchsdk';
import type { AppPaths } from './paths.ts';
import { Sessions, validateDraft } from './sessions.ts';
import { Queue } from './queue.ts';
import { inference } from './inference.ts';
import { readSettings, saveSettings } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Draft } from './types.ts';
import type { Settings } from './settings.ts';
export class Application {
  sessions: Sessions;
  queue: Queue;
  historyIssue?: string;
  private settingsTail: Promise<unknown> = Promise.resolve();
  private runner(): Runner {
    const run = inference(this.sessions, () => this.settings);
    return async (...args) => { const completion = await run(...args); const result = completion.outcome; if (!('status' in result)) this.backup(result.image.path, undefined, result.record.sha256); return completion; };
  }
  private constructor(readonly paths: AppPaths, public settings: Settings, private changed: () => void, private backup: (path: string, bytes?: Buffer, sha256?: string) => void) {
    this.sessions = new Sessions(settings.sessionsDirectory ?? paths.sessions, (path, bytes) => backup(path, bytes), settings.sessionsDirectory !== undefined);
    this.queue = new Queue(this.sessions, this.runner(), changed);
  }
  static async open(paths: AppPaths, changed: () => void = () => {}, backup: (path: string, bytes?: Buffer, sha256?: string) => void = () => {}): Promise<Application> { return new Application(paths, await readSettings(paths.config), changed, backup); }
  async overview() { return { ...await this.sessions.list(), models: listModels(), queue: structuredClone(this.queue.state), historyIssue: this.historyIssue, settings: structuredClone(this.settings) }; }
  async draft(sessionId: string, draft: Draft) { validateDraft(draft); return this.sessions.update(sessionId, value => { value.draft = structuredClone(draft); }); }
  async importImage(sessionId: string, path: string) { const asset = await this.sessions.importImage(sessionId, path); this.backup(await this.sessions.imagePath(sessionId, asset.id), undefined, asset.sha256); return asset; }
  async mask(sessionId: string, bytes: Uint8Array) {
    // Authored mask pixels belong to the GUI; the SDK validates their image semantics on execution.
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024) throw new Error('Invalid mask image.');
    const temporary = join(this.sessions.directory(sessionId), `mask-${randomUUID()}.tmp`);
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); return await this.importImage(sessionId, temporary); }
    finally { await rm(temporary, { force: true }); }
  }
  async remove(sessionId: string) { if (this.queue.busy(sessionId)) throw new Error('Cancel this session’s work before deleting it.'); await this.sessions.remove(sessionId); }
  async export(sessionId: string, runId: string, destination: string, sidecar: boolean, includeInputs: boolean) {
    const session = await this.sessions.get(sessionId); const run = session.runs.find(r => r.id === runId);
    if (!run?.record || !run.output) throw new Error('Select a completed image.');
    const record = structuredClone(run.record);
    if (!includeInputs) { delete record.inputs; delete record.effectiveParameters.negativePrompt; record.inputsIncluded = false; }
    return saveArtifact(await this.sessions.imagePath(sessionId, runId), destination, record, { sidecar });
  }
  async models() { return inspectModels({ profile: this.settings.profile }); }
  async prepare(modelId: string, directory?: string, checkpoint?: string, download = false) {
    const prepared = await prepareModel(modelId, { profile: this.settings.profile, ...(directory ? { directory } : {}), ...(checkpoint ? { checkpoint } : {}), download });
    await this.updateSettings(next => { next.registrations[modelId] = { version: 1, model: prepared.model }; }); return prepared;
  }
  private updateSettings(change: (value: Settings) => void): Promise<void> {
    const next = this.settingsTail.then(async () => {
      const value = structuredClone(this.settings); change(value); validateProfile(value.profile);
      const bytes = await saveSettings(this.paths.config, value);
      this.settings = value; this.backup(this.paths.config, bytes); this.changed();
    });
    this.settingsTail = next.catch(() => {}); return next;
  }
  async collection(directory: string) {
    if (this.queue.busy()) throw new Error('Finish or cancel queued work before changing collections.');
    const selected = new Sessions(directory, (path, bytes) => this.backup(path, bytes), true); await selected.list();
    await this.updateSettings(value => { value.sessionsDirectory = directory; });
    this.sessions = selected; this.queue = new Queue(selected, this.runner(), this.changed);
  }
}
