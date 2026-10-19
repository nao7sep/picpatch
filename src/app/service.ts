import { preference } from '../shared/i18n/index.ts';
import { errorRecord } from './records.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { listModels, inspectModels, prepareModel, saveArtifact, validateProfile, openModel, verifyModel, removeModel, resolveStoragePaths, isPicPatchSdkError } from 'picpatchsdk';
import type { AppPaths } from './paths.ts';
import { Sessions, validateDraft } from './sessions.ts';
import { Queue } from './queue.ts';
import { inference } from './inference.ts';
import { readSettings, saveSettings } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Draft } from './types.ts';
import type { PrepareModelOptions, SdkEvent } from 'picpatchsdk';
import type { Settings } from './settings.ts';
export class Application {
  sessions: Sessions;
  queue: Queue;
  historyIssue?: string | { message: string; notice?: import('../shared/i18n/index.ts').Message };
  private settingsTail: Promise<unknown> = Promise.resolve();
  private runner(): Runner {
    const run = inference(this.sessions, () => this.settings);
    return async (sessionId, attempt, events) => {
      const context = { sessionId, runId: attempt.id };
      let completion;
      try {
        completion = await run(sessionId, attempt, { ...events, onEvent: event => { this.sdkEvents(context)(event); events.onEvent(event); } });
      } catch (error) {
        this.diagnostic(isPicPatchSdkError(error) && error.kind === 'cancelled' ? 'info' : 'error', 'Image attempt ended without a result.', { ...context, error: errorRecord(error) });
        throw error;
      }
      const result = completion.outcome;
      if (!('status' in result)) {
        if (result.sidecar?.status === 'failed') this.diagnostic('warn', 'Image saved; its settings sidecar could not be saved.', { ...context, sidecar: result.sidecar });
        if (result.cleanupWarning) this.diagnostic('warn', 'Image saved with a cleanup warning.', { ...context, warning: result.cleanupWarning });
        this.backup(result.image.path, undefined, result.record.sha256);
      }
      return completion;
    };
  }
  private constructor(readonly paths: AppPaths, public settings: Settings, private changed: () => void, private backup: (path: string, bytes?: Buffer, sha256?: string) => void, private diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) => void) {
    this.sessions = new Sessions(settings.sessionsDirectory ?? paths.sessions, (path, bytes) => backup(path, bytes), settings.sessionsDirectory !== undefined);
    this.queue = new Queue(this.sessions, this.runner(), changed);
  }
  static async open(paths: AppPaths, changed: () => void = () => {}, backup: (path: string, bytes?: Buffer, sha256?: string) => void = () => {}, diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) => void = () => {}): Promise<Application> { return new Application(paths, await readSettings(paths.config), changed, backup, diagnostic); }
  sdkEvents(context: Record<string, unknown> = {}): (event: SdkEvent) => void {
    return event => this.diagnostic(event.level, event.message, { ...context, event });
  }
  async overview() { return { ...await this.sessions.list(), models: listModels(), queue: structuredClone(this.queue.state), historyIssue: typeof this.historyIssue === 'object' ? { message: this.historyIssue.message, notice: this.historyIssue.notice } : this.historyIssue, settings: structuredClone(this.settings), locations: { ...resolveStoragePaths(this.settings.profile.engineDirectory || this.settings.profile.modelsDirectory ? { engineDirectory: this.settings.profile.engineDirectory, modelsDirectory: this.settings.profile.modelsDirectory } : {}), sessionsDirectory: this.sessions.root } }; }
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
    const result = await saveArtifact(await this.sessions.imagePath(sessionId, runId), destination, record, { sidecar, onEvent: this.sdkEvents({ sessionId, runId, action: 'export' }) });
    if (result.status === 'saved' && result.sidecar?.status === 'failed') this.diagnostic('warn', 'Image saved; its settings sidecar could not be saved.', { sessionId, runId, sidecar: result.sidecar });
    return result;
  }
  async models() { return inspectModels({ profile: this.settings.profile, onEvent: this.sdkEvents({ action: 'models' }) }); }
  async prepare(modelId: string, directory?: string, checkpoint?: string, download = false, components: Pick<PrepareModelOptions, 'vae' | 'photoMaker' | 'ipAdapter' | 'clipVision' | 'controlNet' | 'loras'> = {}, signal?: AbortSignal) {
    if (this.queue.busy()) throw new Error('Finish or cancel queued work before changing prepared models.');
    const prepared = await prepareModel(modelId, { ...components, onEvent: this.sdkEvents({ action: 'prepare', modelId }), signal, profile: this.settings.profile, ...(directory ? { directory } : {}), ...(checkpoint ? { checkpoint } : {}), download });
    await this.updateSettings(next => { next.registrations[modelId] = { version: 1, model: prepared.model }; }); return prepared;
  }
  async preferences(value: { engineDirectory?: string; modelsDirectory?: string; nativeExecutable?: string; theme?: 'light' | 'dark'; language?: string }) {
    if (this.queue.busy()) throw new Error('Finish or cancel queued work before changing resource settings.');
    if (value.theme !== undefined && !['light', 'dark'].includes(value.theme)) throw new Error('Invalid theme.');
    await this.updateSettings(next => {
      for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const) {
        if (value[key]) next.profile[key] = value[key]; else delete next.profile[key];
      }
      const language = preference(value.language); if (language) next.language = language; else delete next.language;
      if (value.theme) next.theme = value.theme; else delete next.theme;
    });
  }
  async verify(modelId: string, signal?: AbortSignal) {
    const opened = await openModel(this.settings.registrations[modelId] ?? modelId, { profile: this.settings.profile, signal, onEvent: this.sdkEvents({ modelId }) });
    if (opened.status !== 'ready') return opened;
    return verifyModel(opened.model.directory, opened.model.manifest, { signal, onEvent: this.sdkEvents({ modelId }) });
  }
  async removeManaged(modelId: string, name: string, signal?: AbortSignal) {
    if (this.queue.busy()) throw new Error('Finish or cancel queued work before removing models.');
    return removeModel(modelId, name, { profile: this.settings.profile, signal, onEvent: this.sdkEvents({ modelId }) });
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
