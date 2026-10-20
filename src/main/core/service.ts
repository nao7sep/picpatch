import { modelReadiness } from './model-readiness.ts';
import { preference, UiError } from '../../shared/i18n/index.ts';
import { errorRecord } from './records.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { listModels, inspectModels, prepareModel, saveArtifact, openModel, verifyModel, removeModel, resolveStoragePaths, isPicPatchSdkError } from 'picpatchsdk';
import type { AppPaths } from './paths.ts';
import { Sessions, validateDraft } from './sessions.ts';
import { Queue } from './queue.ts';
import { inference } from './inference.ts';
import { readSettings, saveSettings, usableProfile, validConcurrency } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Draft } from '../../shared/session.ts';
import type { PrepareModelSettings, SdkEvent } from 'picpatchsdk';
import type { Settings } from './settings.ts';
export class Application {
  sessions: Sessions;
  queue: Queue;
  historyIssue?: string | { message: string; notice?: import('../../shared/i18n/index.ts').Message };
  private settingsTail: Promise<unknown> = Promise.resolve();
  private runner(): Runner {
    const run = inference(() => this.sessions, () => this.settings);
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
      if (result.status === 'completed') {
        if (result.sidecar?.status === 'failed') this.diagnostic('warn', 'Image saved; its settings sidecar could not be saved.', { ...context, sidecar: result.sidecar });
        if (result.cleanupWarning) this.diagnostic('warn', 'Image saved with a cleanup warning.', { ...context, warning: result.cleanupWarning });
      }
      return completion;
    };
  }
  private constructor(readonly paths: AppPaths, public settings: Settings, private changed: (scope?: 'progress') => void, private backup: (path: string, bytes?: Buffer, sha256?: string) => void, private diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) => void) {
    this.sessions = new Sessions(settings.sessionsDirectory ?? paths.sessions, (path, bytes) => backup(path, bytes), settings.sessionsDirectory !== undefined);
    this.queue = new Queue(this.sessions, this.runner(), changed, () => this.settings.concurrency ?? 1);
  }
  static async open(paths: AppPaths, changed: (scope?: 'progress') => void = () => {}, backup: (path: string, bytes?: Buffer, sha256?: string) => void = () => {}, diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) => void = () => {}): Promise<Application> {
    const settings = await readSettings(paths.config);
    if (settings.newerProfile !== undefined) diagnostic('warn', 'Resource settings were saved by a newer PicPatch; the defaults are used and the saved settings are kept.', {});
    return new Application(paths, settings, changed, backup, diagnostic);
  }
  sdkEvents(context: Record<string, unknown> = {}): (event: SdkEvent) => void {
    return event => this.diagnostic(event.level, event.message, { ...context, event });
  }
  async overview() { return { ...await this.sessions.list(), models: listModels().filter(model => model.supported), unsupportedModels: listModels().filter(model => !model.supported).length, queue: structuredClone(this.queue.state), historyIssue: typeof this.historyIssue === 'object' ? { message: this.historyIssue.message, notice: this.historyIssue.notice } : this.historyIssue, settings: structuredClone(this.settings), locations: { ...resolveStoragePaths(this.settings.profile.engineDirectory || this.settings.profile.modelsDirectory ? { engineDirectory: this.settings.profile.engineDirectory, modelsDirectory: this.settings.profile.modelsDirectory } : {}), sessionsDirectory: this.sessions.root } }; }
  /** Autosave acknowledges only; the renderer already holds the draft it sent. */
  async draft(sessionId: string, draft: Draft): Promise<void> { const valid = validateDraft(draft); await this.sessions.update(sessionId, value => { value.draft = valid; }); }
  /**
   * Backup history holds what the user authors: settings, session documents and painted masks. Imported copies
   * (the user keeps the original) and generated results (saved with Save image when wanted) are transient work.
   */
  async importImage(sessionId: string, path: string) { return this.sessions.importImage(sessionId, path); }
  async mask(sessionId: string, bytes: Uint8Array) {
    // Authored mask pixels belong to the GUI; the SDK validates their image semantics on execution.
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024) throw new UiError('error.invalid_mask_image');
    const temporary = join(this.sessions.directory(sessionId), `mask-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      const asset = await this.importImage(sessionId, temporary);
      this.backup(await this.sessions.imagePath(sessionId, asset.id), undefined, asset.sha256); return asset;
    }
    finally { await rm(temporary, { force: true }); }
  }
  async remove(sessionId: string) { if (this.queue.busy(sessionId)) throw new UiError('error.cancel_this_sessions_work_before_deleting_it'); await this.sessions.remove(sessionId); }
  async export(sessionId: string, runId: string, destination: string, sidecar: boolean, includeInputs: boolean) {
    const session = await this.sessions.get(sessionId); const run = session.runs.find(r => r.id === runId);
    if (!run?.record || !run.output) throw new UiError('error.select_a_completed_image');
    // The SDK leaves the inputs out of the saved copy when the user did not choose to share them.
    const result = await saveArtifact(await this.sessions.imagePath(sessionId, runId), destination, run.record, { sidecar, includeInputs }, { onEvent: this.sdkEvents({ sessionId, runId, action: 'export' }) });
    if (result.status === 'completed' && result.sidecar?.status === 'failed') this.diagnostic('warn', 'Image saved; its settings sidecar could not be saved.', { sessionId, runId, sidecar: result.sidecar });
    return result;
  }
  /** Presence checks are cheap; the signal bounds a probe that stops responding, such as an engine on a stalled volume. */
  async readiness() { return modelReadiness(this.settings, { signal: AbortSignal.timeout(120_000), onEvent: this.sdkEvents({ action: 'readiness' }) }); }
  async models() { return inspectModels({ profile: this.settings.profile }, { onEvent: this.sdkEvents({ action: 'models' }) }); }
  async prepare(modelId: string, directory?: string, checkpoint?: string, download = false, components: Pick<PrepareModelSettings, 'vae' | 'clipL' | 'clipG' | 't5' | 'photoMaker' | 'ipAdapter' | 'clipVision' | 'controlNet' | 'loras'> = {}, signal?: AbortSignal) {
    this.queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_prepared_models');
    const prepared = await prepareModel(modelId, { ...components, profile: this.settings.profile, ...(directory ? { directory } : {}), ...(checkpoint ? { checkpoint } : {}), download }, { signal, onEvent: this.sdkEvents({ action: 'prepare', modelId }) });
    await this.updateSettings(next => { next.registrations[modelId] = { version: 1, model: prepared.model }; }); return prepared;
  }
  resourcesChanged(value: { engineDirectory?: string; modelsDirectory?: string; nativeExecutable?: string }): boolean {
    return (['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const).some(key => (value[key] || undefined) !== this.settings.profile[key]);
  }
  async preferences(value: { engineDirectory?: string; modelsDirectory?: string; nativeExecutable?: string; theme?: 'light' | 'dark'; language?: string; uiFont?: string; concurrency?: number }) {
    if (this.resourcesChanged(value)) this.queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_resource_settings');
    if (value.theme !== undefined && !['light', 'dark'].includes(value.theme)) throw new UiError('error.invalid_theme');
    if (value.concurrency !== undefined && !validConcurrency(value.concurrency)) throw new UiError('error.invalid_concurrency');
    await this.updateSettings(next => {
      for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const) {
        if (value[key]) next.profile[key] = value[key]; else delete next.profile[key];
      }
      // Choosing resources here replaces a profile a newer PicPatch saved.
      if (this.resourcesChanged(value)) delete next.newerProfile;
      const language = preference(value.language); if (language) next.language = language; else delete next.language;
      if (value.theme) next.theme = value.theme; else delete next.theme;
      if (typeof value.uiFont === 'string' && value.uiFont.trim()) next.uiFont = value.uiFont; else delete next.uiFont;
      if (value.concurrency !== undefined && value.concurrency !== 1) next.concurrency = value.concurrency; else delete next.concurrency;
    });
    // A higher limit starts waiting work at once; a lower one lets running work finish.
    this.queue.wake();
  }
  async verify(modelId: string, signal?: AbortSignal) {
    const opened = await openModel(this.settings.registrations[modelId] ?? modelId, { profile: this.settings.profile }, { signal, onEvent: this.sdkEvents({ modelId }) });
    if (opened.status === 'refused') return opened;
    return verifyModel(opened.model.directory, opened.model.manifest, { signal, onEvent: this.sdkEvents({ modelId }) });
  }
  async removeManaged(modelId: string, name: string, signal?: AbortSignal) {
    this.queue.requireIdle('error.finish_or_cancel_queued_work_before_removing_models');
    return removeModel(modelId, name, { profile: this.settings.profile }, { signal, onEvent: this.sdkEvents({ modelId }) });
  }
  private updateSettings(change: (value: Settings) => void): Promise<void> {
    const next = this.settingsTail.then(async () => {
      const value = structuredClone(this.settings); change(value); usableProfile(value.profile);
      const bytes = await saveSettings(this.paths.config, value);
      this.settings = value; this.backup(this.paths.config, bytes); this.changed();
    });
    this.settingsTail = next.catch(() => {}); return next;
  }
  async collection(directory: string) {
    this.queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_collections');
    const selected = new Sessions(directory, (path, bytes) => this.backup(path, bytes), true);
    if ((await selected.list()).unavailable) throw new UiError('error.storage');
    await this.updateSettings(value => { value.sessionsDirectory = directory; });
    this.queue.use(selected); this.sessions = selected;
  }
}
