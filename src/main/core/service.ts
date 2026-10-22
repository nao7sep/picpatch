import { modelReadiness } from './model-readiness.ts';
import { preference, UiError } from '../../shared/i18n/index.ts';
import { errorRecord } from './records.ts';
import { listModels, inspectModels, prepareModel, saveArtifact, openModel, verifyModel, removeModel, resolveStoragePaths, isPicPatchSdkError, inspectEngine, inspectNativeEngine, installEngine, installNativeEngine } from 'picpatchsdk';
import { isAbsolute, join } from 'node:path';
import { exportName } from '../../shared/export-name.ts';
import { validTimeZone } from '../../shared/time-zone.ts';
import type { AppPaths } from './paths.ts';
import { Sessions, validateDraft } from './sessions.ts';
import { Queue } from './queue.ts';
import { inference } from './inference.ts';
import { readSettings, saveSettings, usableProfile, validConcurrency } from './settings.ts';
import type { Runner } from './queue.ts';
import type { Draft, Session } from '../../shared/session.ts';
import type { PrepareModelSettings, SdkEvent } from 'picpatchsdk';
import type { Settings } from './settings.ts';
/** The Python runtime the catalog names for a model; native models and no selection use the default Python engine. */
function pythonEngine(modelId: unknown) {
  const runtime = listModels().find(model => model.id === modelId)?.runtime;
  return runtime?.engine === 'python' ? { runtime: runtime.name } : {};
}
/**
 * Where a Python engine build looks for tools such as CMake: the absolute directories on PATH, then the usual
 * Homebrew locations, which a GUI launch from Finder does not have on PATH.
 */
export function pythonToolDirectories(path: string | undefined, delimiter: string): string[] {
  return [...new Set([...(path ?? '').split(delimiter).filter(isAbsolute), '/opt/homebrew/bin', '/usr/local/bin'])];
}
/** A model the app may download: pinned in the catalog and runnable on this computer. */
export function downloadableModel(modelId: unknown) {
  const model = listModels().find(item => item.id === modelId);
  if (!model || model.acquisition !== 'pinned' || !model.supported) throw new UiError('ui.no_downloadable_bundle_for_this_selection');
  return model;
}
/** Save image suggests the image's number as shown in the conversation, in the folder the last save used. */
export function exportDefaultPath(session: Session, runId: string, directory: string | undefined): string {
  const index = session.runs.findIndex(run => run.id === runId && run.output);
  if (index < 0) throw new UiError('ui.choose_completed_results');
  const name = exportName(session.name, index + 1);
  return directory ? join(directory, name) : name;
}
export class Application {
  sessions: Sessions;
  queue: Queue;
  historyIssue?: string | { message: string; notice?: import('../../shared/i18n/index.ts').Message };
  private settingsTail: Promise<unknown> = Promise.resolve();
  private managed?: { controller: AbortController; task: Promise<unknown> };
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
  private constructor(readonly paths: AppPaths, public settings: Settings, private changed: (scope?: 'progress') => void, private backup: (path: string, bytes: Buffer) => void, private diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) => void) {
    this.sessions = new Sessions(settings.sessionsDirectory ?? paths.sessions, (path, bytes) => backup(path, bytes), settings.sessionsDirectory !== undefined);
    this.queue = new Queue(this.sessions, this.runner(), changed, () => this.settings.concurrency ?? 1);
  }
  static async open(paths: AppPaths, changed: (scope?: 'progress') => void = () => {}, backup: (path: string, bytes: Buffer) => void = () => {}, diagnostic: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details: Record<string, unknown>) => void = () => {}): Promise<Application> {
    const settings = await readSettings(paths.config);
    return new Application(paths, settings, changed, backup, diagnostic);
  }
  sdkEvents(context: Record<string, unknown> = {}): (event: SdkEvent) => void {
    return event => this.diagnostic(event.level, event.message, { ...context, event });
  }
  async overview() {
    const { engineDirectory, modelsDirectory } = this.settings.profile;
    const resources = resolveStoragePaths(engineDirectory || modelsDirectory ? { engineDirectory, modelsDirectory } : {});
    const historyIssue = typeof this.historyIssue === 'object' ? { message: this.historyIssue.message, notice: this.historyIssue.notice } : this.historyIssue;
    return {
      ...await this.sessions.list(),
      models: listModels().filter(model => model.supported), unsupportedModels: listModels().filter(model => !model.supported).length,
      queue: structuredClone(this.queue.state), resourcesBusy: this.resourcesBusy(), historyIssue,
      settings: structuredClone(this.settings), resourceDefaults: resolveStoragePaths(), locations: { ...resources, sessionsDirectory: this.sessions.root },
    };
  }
  /**
   * Resource operations (preparing, verifying or removing models, installing engines) run one at a time and receive
   * the operation's cancellation signal. Image work does not start while one runs, and the queue's own idle checks
   * keep resources from changing under image work.
   */
  private manage<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.managed) return Promise.reject(new UiError('ui.wait_for_the_current_managed_operation_or_cancel_it'));
    const controller = new AbortController(); const task = work(controller.signal);
    const managed = this.managed = { controller, task };
    return task.finally(() => { if (this.managed === managed) this.managed = undefined; });
  }
  private requireNoResourceOperation() { if (this.managed) throw new UiError('ui.wait_for_the_current_resource_operation'); }
  get managing(): boolean { return this.managed !== undefined; }
  resourcesBusy(): boolean { return this.managing || this.queue.busy(); }
  cancelManaged(): void { this.managed?.controller.abort(); }
  /** Cancels the running resource operation and waits until it has settled. */
  async stopManaged(): Promise<void> { const managed = this.managed; managed?.controller.abort(); await managed?.task.catch(() => {}); }
  submit(sessionId: string, draft: Draft, samples: number) { this.requireNoResourceOperation(); return this.queue.submit(sessionId, draft, samples); }
  resume(sessionId: string) { this.requireNoResourceOperation(); return this.queue.resume(sessionId); }
  async engines(modelId: unknown) {
    const events = { onEvent: this.sdkEvents({ action: 'engines' }) };
    return { python: await inspectEngine({ ...pythonEngine(modelId), profile: this.settings.profile }, events), native: await inspectNativeEngine({ profile: this.settings.profile }, events) };
  }
  installNative() { return this.manage(signal => installNativeEngine({ profile: this.settings.profile }, { signal, onEvent: this.sdkEvents({ action: 'installNative' }) })); }
  installPython(modelId: unknown, uvExecutable: string, toolDirectories: string[]) {
    return this.manage(signal => installEngine({ ...pythonEngine(modelId), profile: this.settings.profile, uvExecutable, toolDirectories }, { signal, onEvent: this.sdkEvents({ action: 'installPython' }) }));
  }
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
    const asset = await this.sessions.addImage(sessionId, 'mask.png', bytes);
    this.backup(await this.sessions.imagePath(sessionId, asset.id), Buffer.from(bytes)); return asset;
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
  prepare(modelId: string, directory?: string, checkpoint?: string, download = false, components: Pick<PrepareModelSettings, 'vae' | 'clipL' | 'clipG' | 't5' | 'photoMaker' | 'ipAdapter' | 'clipVision' | 'controlNet' | 'loras'> = {}) {
    return this.manage(async signal => {
      this.queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_prepared_models');
      const prepared = await prepareModel(modelId, { ...components, profile: this.settings.profile, ...(directory ? { directory } : {}), ...(checkpoint ? { checkpoint } : {}), download }, { signal, onEvent: this.sdkEvents({ action: 'prepare', modelId }) });
      await this.updateSettings(next => { next.registrations[modelId] = { version: 1, model: prepared.model }; }); return prepared;
    });
  }
  resourcesChanged(value: { engineDirectory?: string; modelsDirectory?: string; nativeExecutable?: string }): boolean {
    return (['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const).some(key => (value[key] || undefined) !== this.settings.profile[key]);
  }
  async preferences(value: { engineDirectory?: string; modelsDirectory?: string; nativeExecutable?: string; theme?: 'light' | 'dark'; language?: string; uiFont?: string; concurrency?: number; timeZone?: string }) {
    if (this.resourcesChanged(value)) { this.requireNoResourceOperation(); this.queue.requireIdle('error.finish_or_cancel_queued_work_before_changing_resource_settings'); }
    if (value.theme !== undefined && !['light', 'dark'].includes(value.theme)) throw new UiError('error.invalid_theme');
    if (value.timeZone !== undefined && !validTimeZone(value.timeZone)) throw new UiError('error.invalid_time_zone');
    if (value.concurrency !== undefined && !validConcurrency(value.concurrency)) throw new UiError('error.invalid_concurrency');
    await this.updateSettings(next => {
      for (const key of ['engineDirectory', 'modelsDirectory', 'nativeExecutable'] as const) {
        if (value[key]) next.profile[key] = value[key]; else delete next.profile[key];
      }
      const language = preference(value.language); if (language) next.language = language; else delete next.language;
      if (value.theme) next.theme = value.theme; else delete next.theme;
      if (value.timeZone) next.timeZone = value.timeZone; else delete next.timeZone;
      if (typeof value.uiFont === 'string' && value.uiFont.trim()) next.uiFont = value.uiFont; else delete next.uiFont;
      if (value.concurrency !== undefined && value.concurrency !== 1) next.concurrency = value.concurrency; else delete next.concurrency;
    });
    // A higher limit starts waiting work at once; a lower one lets running work finish.
    this.queue.wake();
  }
  verify(modelId: string) {
    return this.manage(async signal => {
      const opened = await openModel(this.settings.registrations[modelId] ?? modelId, { profile: this.settings.profile }, { signal, onEvent: this.sdkEvents({ modelId }) });
      if (opened.status === 'refused') return opened;
      return verifyModel(opened.model.directory, opened.model.manifest, { signal, onEvent: this.sdkEvents({ modelId }) });
    });
  }
  removeManaged(modelId: string, name: string) {
    return this.manage(async signal => {
      this.queue.requireIdle('error.finish_or_cancel_queued_work_before_removing_models');
      return removeModel(modelId, name, { profile: this.settings.profile }, { signal, onEvent: this.sdkEvents({ modelId }) });
    });
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
