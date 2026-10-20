import { startupFailureWindow } from './startup-failure.ts';
import { exportName } from '../shared/export-name.ts';
import { menuTemplate } from './menu-template.ts';
import { RecordsReader } from './core/records-reader.ts';
import { focusWorkspaceForCommand } from './workspace-command.ts';
import { LogsWindow } from './logs-window.ts';
import { about } from '../shared/about.ts';
import { normalizeZoom, nextZoom, windowMinimum } from '../shared/appearance.ts';
import type { PaneState } from './core/layout-state.ts';
import { shortcutCommand } from '../shared/shortcuts.ts';
import { rendererRequests } from './renderer-requests.ts';
import { quitFlow } from './quit.ts';
import type { Message } from '../shared/i18n/index.ts';
import { bootstrapLanguage, selectLanguage, localeState, prepareChromiumLanguage } from './language.ts';
import { t, number, errorText, errorNotice, UiError, message } from '../shared/i18n/index.ts';
import { Records, errorRecord } from './core/records.ts';
import { checkPaneState, readPaneState, savePaneState } from './core/layout-state.ts';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, powerMonitor, nativeTheme, systemPreferences, screen, session as browserSession, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { dirname, join, isAbsolute, delimiter } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { qualifyInference, qualifyLocalization, qualifyLogs } from './qualification.ts';
import { installEngine, installNativeEngine, inspectEngine, inspectNativeEngine, isPicPatchSdkError, listModels } from 'picpatchsdk';
import { insideBundle, trustedSender } from './trust.ts';
import { appPaths, resolveAppPaths } from './core/paths.ts';
import { Application } from './core/service.ts';
import { minimum, thumbnailSize } from '../shared/layout.ts';
import { Thumbnails } from './core/thumbnails.ts';
import { locations } from './locations.ts';
import type { Draft } from '../shared/session.ts';
app.setName('PicPatch');
let earlyFailure: unknown;
try { prepareChromiumLanguage(resolveAppPaths().config); } catch (error) { earlyFailure = error; }
protocol.registerSchemesAsPrivileged([{ scheme: 'picpatch-image', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window: BrowserWindow | undefined; let service: Application; let quitting = false;
let backup: Worker | undefined;
let records: Records | undefined;
let logs: LogsWindow | undefined;
let recordsReader: RecordsReader | undefined;
let managed: { controller: AbortController; task: Promise<unknown> } | undefined;
let paths: Awaited<ReturnType<typeof appPaths>>;
try {
  paths = await appPaths();
  app.setPath('userData', paths.root); app.setPath('sessionData', join(paths.root, 'browser'));
  await mkdir(join(paths.root, 'browser'), { recursive: true, mode: 0o700 });
} catch (error) { earlyFailure = error; }
const qualificationIndex = process.argv.indexOf('--smoke-inference');
const qualification = qualificationIndex < 0 ? undefined : process.argv[qualificationIndex + 1];
const localizationSmoke = process.argv.includes('--smoke-localization');
const backgroundReload = !app.isPackaged && process.argv.includes('--background-reload');
const smoke = process.argv.includes('--smoke') || qualificationIndex >= 0 || localizationSmoke;
// Smoke runs change settings and create sessions, so they only run against a separate data folder.
if (smoke && !process.env.PICPATCH_DATA_DIR) { console.error('Smoke runs require PICPATCH_DATA_DIR.'); process.exit(2); }
let smokeTimer: ReturnType<typeof setTimeout> | undefined;
let paneState: PaneState;
const thumbnails = new Thumbnails(thumbnailSize);
let paneWrites = Promise.resolve();
let contentFloor = minimum(false);
let appliedMinimum = '';
function storePane(patch: Partial<PaneState>) {
  // An invalid patch is refused before it can stick in memory and fail every later save.
  const next = { ...paneState, ...patch }; checkPaneState(next); paneState = next;
  const snapshot = { ...paneState }; if (snapshot.uiZoom === 1) delete snapshot.uiZoom;
  paneWrites = paneWrites.catch(() => {}).then(() => savePaneState(paths.state, snapshot));
  return paneWrites;
}
function fitMinimum() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getSize(); const [contentWidth, contentHeight] = window.getContentSize();
  const floor = windowMinimum(contentFloor, window.webContents.getZoomFactor(), { width: width - contentWidth, height: height - contentHeight }, screen.getDisplayMatching(window.getBounds()).workAreaSize);
  const key = JSON.stringify(floor); if (key === appliedMinimum) return; appliedMinimum = key;
  window.setMinimumSize(floor.width, floor.height);
}
function systemDark() {
  // The macOS global preference remains independent of Electron's app override.
  return process.platform === 'darwin' ? systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark' : nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
}
let rendererReady = false;
let closing = false;
const requests = rendererRequests((id, request) => {
  if ((quitting && request.kind !== 'flush') || !rendererReady || !window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('Editor unavailable.');
  window.webContents.send('picpatch:request', id, request);
});
ipcMain.on('picpatch:reply', (event, reply) => {
  if (trustedSender(event, window, locations.page('index'))) requests.reply(reply);
});
async function ask(options: { message: Message; detail?: Message; buttons: Message[]; destructive?: boolean; duringClose?: boolean }) {
  if (closing && !options.duringClose) return { response: undefined };
  const response = await requests.request({ kind: 'message', message: {
    title: options.message, detail: options.detail,
    actions: options.buttons.map((label, index) => ({ label, destructive: options.destructive !== false && index > 0 && index === options.buttons.length - 1 })),
  } });
  return { response };
}
/** Whether a renderer is listening for requests; a crashed or reloading one holds no unsaved editor state. */
const editorAvailable = () => rendererReady && !!window && !window.isDestroyed() && !window.webContents.isDestroyed();
/** A step stuck in native I/O would hold Electron's own exit, so the bounded teardown ends with SIGKILL instead. */
const forceExit = () => process.kill(process.pid, 'SIGKILL');
const delay = (milliseconds: number) => new Promise<'late'>(resolve => setTimeout(() => resolve('late'), milliseconds));
const lifetime = quitFlow({
  freeze: value => { closing = value; command(value ? 'beginClose' : 'endClose'); },
  flush: async () => { if (editorAvailable()) await requests.request({ kind: 'flush' }, 5000); },
  drafts: async () => !editorAvailable() || await requests.request({ kind: 'closeDrafts' }) === true,
  saveFailure: async error => {
    records?.write('error', 'Pending editor saves did not complete.', { error: errorRecord(error) });
    return (await ask({ duringClose: true, message: message('ui.pending_changes_could_not_be_saved'), buttons: [message('ui.keep_working'), message('ui.retry_save'), message('ui.quit_without_pending_changes')] })).response;
  },
  work: async () => {
    if (managed && (await ask({ duringClose: true, message: message('ui.cancel_the_installation_or_verification_and_quit'), buttons: [message('ui.keep_working'), message('ui.cancel_and_quit')] })).response !== 1) return false;
    if (service.queue.busy() && (await ask({ duringClose: true, message: message('ui.cancel_the_remaining_work_and_quit'), buttons: [message('ui.keep_working'), message('ui.cancel_work_and_quit')] })).response !== 1) return false;
    return true;
  },
  finish: async () => {
    const pending = managed; pending?.controller.abort(); await pending?.task.catch(() => {});
    await service.queue.stop();
    if (quitting) return;
    // Saves already accepted (renames, masks, exports) settle before teardown, within a bound a stalled volume cannot extend.
    const late = await Promise.race([service.sessions.settled().then(() => 'settled' as const), delay(5000)]) === 'late';
    if (late) records?.write('warn', 'Session saves did not settle before quitting.');
    if (backup) { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); const done = (reply: any) => { if (reply.flushed === 'quit') { clearTimeout(timer); backup?.off('message', done); resolve(); } }; backup!.on('message', done); backup!.postMessage({ flush: 'quit' }); }); await backup.terminate(); }
    logs?.close(); await recordsReader?.close();
    records?.write('info', 'PicPatch closed normally.');
    const recordsLate = await Promise.race([records?.close().then(() => 'closed' as const), delay(2000)]) === 'late';
    quitting = true;
    // Electron's own exit waits on Node cleanup, which a step still stuck in native I/O would hold forever.
    if (late || recordsLate) forceExit(); else app.quit();
  },
  failed: async error => {
    records?.write('error', 'Closing did not complete.', { error: errorRecord(error) });
    try { await ask({ duringClose: true, message: message('ui.picpatch_could_not_finish_closing'), buttons: [message('ui.keep_working')] }); }
    catch { /* No usable message surface: ordinary quit remains cancelled. */ }
  },
  interrupt: () => { quitting = true; command('shutdown'); requests.cancelAll(); managed?.controller.abort(); void service?.queue.stop(); },
  shutdownSave: async () => { await requests.request({ kind: 'flush' }, 800); await service.sessions.settled(); },
  exit: () => app.exit(0),
  forceExit,
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { if (!backgroundReload || rendererReady) window?.show(); });
  void app.whenReady().then(start).catch(startupFailure);
}
async function startupFailure(error: unknown) {
  quitting = true; clearTimeout(smokeTimer); requests.cancelAll();
  window?.destroy(); logs?.close();
  await Promise.allSettled([backup?.terminate(), recordsReader?.close(), records?.close()]);
  if (smoke) { console.error(error); app.exit(1); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PicPatch', submenu: [{ label: t('native.quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.exit(1) }] },
    { label: t('native.edit'), submenu: [{ role: 'copy', label: t('native.copy') }, { role: 'selectAll', label: t('native.selectAll') }] },
  ]));
  // Retry starts with a clean process, not duplicate IPC handlers or half-open stores.
  try { window = await startupFailureWindow(error, nativeTheme.shouldUseDarkColors, () => { app.relaunch(); app.exit(0); }, () => app.exit(1)); }
  catch (failure) { console.error('Startup failure window could not open.', failure); app.exit(1); }
}
function command(id: string) { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) { focusWorkspaceForCommand(window, id); window.webContents.send('picpatch:command', id); } }
async function start() {
  // No page needs camera, notifications or other browser permissions.
  browserSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.defaultSession.setPermissionCheckHandler(() => false);
  if (earlyFailure) throw earlyFailure;
  await bootstrapLanguage(paths.config);
  records = new Records(paths.root, locations.worker('records-worker'), () => logs?.changed());
  recordsReader = new RecordsReader(paths.root, records.session, locations.worker('records-reader-worker'));
  records.write('info', 'PicPatch started.', { version: app.getVersion() });
  process.on('uncaughtExceptionMonitor', error => records?.write('error', 'Uncaught exception.', { error: errorRecord(error) }));
  backup = new Worker(locations.worker('backup-worker'));
  backup.on('error', () => { if (service) service.historyIssue = new UiError('ui.backup_history_is_unavailable_primary_session_saves_remain_active'); });
  backup.on('message', message => { if (message.issue && service) { records?.write('warn', 'Backup capture failed.', { diagnostic: message.issue }); service.historyIssue = new UiError('ui.backup_history_could_not_capture_some_work_primary_session'); window?.webContents.send('picpatch:changed'); } });
  service = await Application.open(paths, scope => scope === 'progress' ? window?.webContents.send('picpatch:queue', service?.queue.state) : window?.webContents.send('picpatch:changed'), (path, bytes, sha256) => backup?.postMessage({ database: paths.backups, path, bytes, sha256 }), (level, message, details) => records?.write(level, message, details));
  protocol.handle('picpatch-image', async request => {
    try {
      const url = new URL(request.url); const path = await service.sessions.imagePath(url.hostname, url.pathname.slice(1));
      // Session images never change after they are written, so a thumbnail is cached by path.
      if (url.searchParams.get('size') === String(thumbnailSize)) return new Response(new Uint8Array(await thumbnails.get(path)), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
      const response = await net.fetch(pathToFileURL(path).href); const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*'); return new Response(response.body, { status: response.status, headers });
    }
    catch { return new Response('Image unavailable', { status: 404 }); }
  });
  logs = new LogsWindow(recordsReader, () => ({ locale: localeState(), dark: nativeTheme.shouldUseDarkColors, uiFont: service.settings.uiFont, uiZoom: paneState?.uiZoom, listWidth: paneState?.recordsListWidth }), error => records?.write('error', 'Logs could not be read.', { error: errorRecord(error) }), width => storePane({ recordsListWidth: width }));
  const renderer = locations.page('index');
  ipcMain.handle('picpatch:call', async (event, action: string, payload: any = {}) => {
    if (!trustedSender(event, window, renderer)) throw new Error('Untrusted request.');
    try {
      if (!['ready', 'listening', 'renderer-error', 'overview', 'get', 'draft', 'layout', 'paneState', 'modalState', 'focus'].includes(action)) records?.write('info', 'Command requested.', { action });
      if (['prepare', 'verify', 'removeManaged', 'installPython', 'installNative'].includes(action)) {
        if (managed) throw new UiError('ui.wait_for_the_current_managed_operation_or_cancel_it');
        const controller = new AbortController(); const task = dispatch(action, payload, controller.signal);
        managed = { controller, task };
        try { return { ok: true, value: await task }; } finally { managed = undefined; }
      }
      return { ok: true, value: await dispatch(action, payload) };
    }
    catch (error) { records?.write(isPicPatchSdkError(error) && error.kind === 'cancelled' ? 'info' : 'error', 'Command did not complete.', { action, error: errorRecord(error) }); return { ok: false, message: errorText(error), ...(isPicPatchSdkError(error) ? { code: error.code, kind: error.kind, effect: error.effect } : {}), notice: errorNotice(error) }; }
  });
  paneState = await readPaneState(paths.state);
  nativeTheme.themeSource = service.settings.theme ?? 'system';
  nativeTheme.on('updated', () => { logs?.updateAppearance(); window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#11181b' : '#f3f4f1'); if (rendererReady) window?.webContents.send('picpatch:changed'); });
  menus();
  window = new BrowserWindow({ name: 'picpatch-main', windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' }, width: 1280, height: 850, minWidth: minimum(false).width, minHeight: minimum(false).height, title: 'PicPatch', ...(process.platform === 'darwin' ? {} : { icon: locations.icon() }), show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#11181b' : '#f3f4f1', webPreferences: { zoomFactor: normalizeZoom(paneState.uiZoom), preload: locations.preload('index'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.on('move', fitMinimum);
  screen.on('display-metrics-changed', fitMinimum);
  fitMinimum();
  window.webContents.on('before-input-event', (_event, input) => { window?.webContents.setIgnoreMenuShortcuts(input.isComposing || shortcutCommand({ key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }) !== undefined); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== renderer) event.preventDefault(); });
  window.once('ready-to-show', () => { if (!smoke) { if (backgroundReload) window?.showInactive(); else window?.show(); } });
  if (smoke) smokeTimer = setTimeout(() => { app.exit(1); }, qualification ? 300_000 : localizationSmoke ? 240_000 : 15000);
  window.on('close', event => { if (!quitting) { event.preventDefault(); void lifetime.close(); } });
  process.on('SIGTERM', () => lifetime.shutdown());
  window.on('query-session-end', () => lifetime.shutdown());
  window.on('session-end', () => lifetime.shutdown());
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void lifetime.close(); } });
  powerMonitor.on('shutdown', () => { records?.write('info', 'OS shutdown requested.'); lifetime.shutdown(); });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererReady = false; requests.cancelAll();
    records?.write('error', 'The window renderer stopped.', { reason: details.reason, exitCode: details.exitCode });
    // Its drafts went with it; reload so the workspace (and quit questions) work again.
    if (!quitting && details.reason !== 'clean-exit' && window && !window.isDestroyed()) void window.webContents.reload();
  });
  window.webContents.on('did-start-loading', () => { rendererReady = false; requests.cancelAll(); });
  window.on('closed', () => { rendererReady = false; requests.cancelAll(); });
  await window.loadURL(renderer);
}
async function pick(properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string) {
  const result = await dialog.showOpenDialog(window!, { title, properties }); return result.canceled ? [] : result.filePaths;
}
/** The Python runtime the catalog names for a model; native models and no selection use the default Python engine. */
function pythonEngine(modelId: unknown) {
  const runtime = listModels().find(model => model.id === modelId)?.runtime;
  return runtime?.engine === 'python' ? { runtime: runtime.name } : {};
}
async function dispatch(action: string, payload: any, signal?: AbortSignal) {
  switch (action) {
    case 'modalState': modalOpen = payload.open === true; for (const id of ['picpatch-about','picpatch-settings']) { const item = Menu.getApplicationMenu()?.getMenuItemById(id); if (item) item.enabled = !modalOpen; } return;
    case 'closeWindow': void lifetime.close(); return;
    case 'openProjectLink': { if (payload.destination !== 'repository' && payload.destination !== 'issues') throw new Error('Unknown project link.'); await shell.openExternal(about[payload.destination as 'repository' | 'issues']); return; }
    case 'openLogs': try { await logs?.open(); } catch (error) { records?.write('error', 'Logs window could not open.', { error: errorRecord(error) }); throw new UiError('logs.openFailed'); } return;
    case 'listening': rendererReady = true; return;
    case 'renderer-error': records?.write('error', 'Renderer error.', { error: typeof payload.message === 'string' ? payload.message.slice(0, 2000) : 'unknown', stack: typeof payload.stack === 'string' ? payload.stack.slice(0, 8000) : undefined }); return;
    case 'ready': rendererReady = true; if (smoke) { if (app.isPackaged && !await window!.webContents.executeJavaScript("(() => { try { new Function(''); return false; } catch { return true; } })()")) { console.error('The packaged renderer runs without its content security policy.'); app.exit(1); return; } if (localizationSmoke) { try { await qualifyLocalization(window!, paths.root, command); await qualifyLogs(await logs!.open(false), window!); logs!.close(); } catch (error) { console.error(error); app.exit(1); return; } } if (qualification) { try { await qualifyInference(service, qualification, locations.uv()); } catch (error) { console.error(error); app.exit(1); return; } } clearTimeout(smokeTimer); await backup?.terminate(); await records?.close(); app.exit(0); } return;
    case 'paneState': if (payload.railWidth !== undefined) { await storePane({ railWidth: payload.railWidth, optionsPane: payload.optionsPane }); return; } return paneState;
    case 'layout': { const size = minimum(payload.optionsPane === true); contentFloor = { width: size.width, height: Number.isFinite(payload.height) ? Math.max(size.height, payload.height) : size.height }; fitMinimum(); return; }
    case 'uiZoom': {
      if (!['in', 'out', 'reset'].includes(payload.direction)) throw new Error('Invalid UI zoom command.');
      const zoom = nextZoom(window!.webContents.getZoomFactor(), payload.direction);
      window!.webContents.setZoomFactor(zoom); fitMinimum();
      await storePane({ uiZoom: zoom }).catch(error => records?.write('warn', 'UI zoom could not be retained.', { error: errorRecord(error) })); logs?.updateAppearance(); return;
    }
    case 'locale': return { ...localeState(), uiFont: service.settings.uiFont };
    case 'modelReadiness': return service.readiness();
    case 'overview': return { ...await service.overview(), resourcesBusy: Boolean(managed) || service.queue.busy(), locale: localeState(), systemDark: systemDark() };
    case 'create': return service.sessions.create(t('session.untitled'));
    case 'get': return service.sessions.get(payload.id);
    case 'focus': service.queue.focus(typeof payload.id === 'string' ? payload.id : undefined); return;
    case 'draft': return service.draft(payload.id, payload.draft as Draft);
    case 'rename': if (typeof payload.name !== 'string' || !payload.name.trim()) throw new UiError('ui.enter_a_session_name'); return service.sessions.update(payload.id, session => { session.name = payload.name; });
    case 'delete': { if (service.queue.busy(payload.id)) throw new UiError('error.cancel_this_sessions_work_before_deleting_it'); const answer = await ask({ message: message('ui.delete_this_session_and_its_retained_images'), detail: message('ui.exported_images_and_original_files_are_kept'), buttons: [message('ui.keep_session'), message('ui.delete_session')] }); if (answer.response !== 1) return false; await service.remove(payload.id); return true; }
    case 'import': { const files = payload.path ? [payload.path] : await pick(payload.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'], t('ui.add_images')); const assets = []; for (const path of files) assets.push(await service.importImage(payload.id, path)); return assets; }
    case 'mask': return service.mask(payload.id, payload.bytes);
    case 'submit': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); return service.queue.submit(payload.id, payload.draft, payload.samples);
    case 'cancel': return service.queue.cancel(payload.id, payload.runId);
    case 'resume': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); return service.queue.resume(payload.id);
    case 'export': {
      const session = await service.sessions.get(payload.id);
      // The default name uses the image's number as shown in the conversation.
      const index = session.runs.findIndex(run => run.id === payload.runId && run.output);
      if (index < 0) throw new UiError('ui.choose_completed_results');
      const name = exportName(session.name, index + 1);
      const result = await dialog.showSaveDialog(window!, { title: t('ui.save_image'), defaultPath: paneState.exportDirectory ? join(paneState.exportDirectory, name) : name, filters: [{ name: t('ui.png_image'), extensions: ['png'] }] });
      if (result.canceled || !result.filePath) return;
      const saved = await service.export(payload.id, payload.runId, result.filePath, payload.sidecar === true, payload.includeInputs === true);
      if (saved.status === 'completed') await storePane({ exportDirectory: dirname(result.filePath) }).catch(error => records?.write('warn', 'Export destination could not be retained.', { error: errorRecord(error) }));
      return saved;
    }
    case 'cancelManaged': managed?.controller.abort(); return;
    case 'preferences': if (managed && service.resourcesChanged(payload)) throw new UiError('ui.wait_for_the_current_resource_operation'); await service.preferences(payload); nativeTheme.themeSource = service.settings.theme ?? 'system'; await selectLanguage(service.settings.language); menus(); logs?.updateAppearance(); window?.webContents.send('picpatch:changed'); return service.overview();
    case 'pickPath': return (await pick([payload.file ? 'openFile' : 'openDirectory'], t('ui.choose_location')))[0];
    case 'pickComponent': {
      if (typeof payload.directory !== 'string' || !isAbsolute(payload.directory)) throw new UiError('ui.choose_the_model_bundle_first');
      const file = (await pick(['openFile'], t('ui.choose_a_file_inside_the_model_bundle')))[0]; if (!file) return;
      const path = insideBundle(payload.directory, file); if (!path) throw new UiError('ui.choose_a_file_inside_the_selected_bundle'); return path;
    }
    case 'verify': return service.verify(payload.modelId, signal);
    case 'removeManaged': {
      const answer = await ask({ message: message('ui.remove_this_managed_model_revision'), detail: message('ui.other_apps_using_this_shared_model_may_fail_sessions'), buttons: [message('ui.keep_model'), message('ui.remove_revision')] });
      if (answer.response === 1) return service.removeManaged(payload.modelId, payload.name, signal); return;
    }
    case 'models': return service.models();
    case 'prepare': { if (payload.download) { const model = listModels().find(m => m.id === payload.modelId); if (!model || model.acquisition !== 'pinned' || !model.supported) throw new UiError('ui.no_downloadable_bundle_for_this_selection'); const answer = await ask({ message: message('management.download', { model: model.profile.name }), detail: message('management.downloadScope', { size: number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 }) }), buttons: [message('ui.cancel'), message('ui.download')], destructive: false }); if (answer.response !== 1) return; return service.prepare(model.id, undefined, undefined, true, {}, signal); }
      // Native bundles name their checkpoint through pickComponent before Register is enabled.
      const paths = payload.directory ? [payload.directory] : await pick(['openDirectory'], t('ui.select_the_model_bundle')); if (!paths[0]) return;
      return service.prepare(payload.modelId, paths[0], payload.checkpoint, false, payload.components, signal); }
    case 'engines': return { python: await inspectEngine({ ...pythonEngine(payload.modelId), profile: service.settings.profile }, { onEvent: service.sdkEvents({ action }) }), native: await inspectNativeEngine({ profile: service.settings.profile }, { onEvent: service.sdkEvents({ action }) }) };
    case 'installNative': return installNativeEngine({ profile: service.settings.profile }, { signal, onEvent: service.sdkEvents({ action }) });
    case 'installPython': { const uvExecutable = locations.uv(); return installEngine({ ...pythonEngine(payload.modelId), profile: service.settings.profile, uvExecutable, toolDirectories: [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), '/opt/homebrew/bin', '/usr/local/bin'])] }, { signal, onEvent: service.sdkEvents({ action }) }); }
    case 'collection': { const paths = await pick(['openDirectory'], t('ui.open_sessions_collection')); if (!paths[0]) return false; await service.collection(paths[0]); return true; }
    default: throw new Error('Unknown action.');
  }
}

let modalOpen = false;
function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform === 'darwin', app.isPackaged, modalOpen, command, () => {
    const focused = BrowserWindow.getFocusedWindow(); if (focused && focused !== window) focused.close(); else command('closeWindow');
  })));
}
