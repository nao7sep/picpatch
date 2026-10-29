import { readSettingsSync, type Settings } from './core/settings.ts';
import { pickBundleComponent, pickPaths } from './native-pickers.ts';
import { startupFailureWindow } from './startup-failure.ts';
import { menuTemplate } from './menu-template.ts';
import { focusWorkspaceForCommand } from './workspace-command.ts';
import { LogsWindow } from './logs-window.ts';
import { about } from '../shared/about.ts';
import { normalizeZoom, nextZoom, windowBackground, windowMinimum } from '../shared/appearance.ts';
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
import { pathToFileURL } from 'node:url';
import { dirname, join, delimiter } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runSmoke } from './qualification.ts';
import { isPicPatchSdkError } from 'picpatchsdk';
import { trustedSender } from './trust.ts';
import { appPaths, resolveAppPaths } from './core/paths.ts';
import { Application, downloadableModel, exportDefaultPath, pythonToolDirectories } from './core/service.ts';
import { Backup } from './core/backup.ts';
import { minimum, thumbnailSize } from '../shared/layout.ts';
import { Thumbnails } from './core/thumbnails.ts';
import { locations } from './locations.ts';
import type { Draft } from '../shared/session.ts';
app.setName('PicPatch');
let earlyFailure: unknown;
let startupSettings: Settings;
try { startupSettings = readSettingsSync(resolveAppPaths().config); prepareChromiumLanguage(startupSettings.language); } catch (error) { earlyFailure = error; }
protocol.registerSchemesAsPrivileged([{ scheme: 'picpatch-image', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window: BrowserWindow | undefined; let service: Application; let quitting = false;
let backup: Backup | undefined;
let records: Records | undefined;
let logs: LogsWindow | undefined;
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
const lifetime = quitFlow({
  freeze: value => { closing = value; command(value ? 'beginClose' : 'endClose'); },
  flush: async remaining => { if (editorAvailable()) await requests.request({ kind: 'flush' }, remaining); },
  drafts: async () => !editorAvailable() || await requests.request({ kind: 'closeDrafts' }) === true,
  saveFailure: async error => {
    records?.write('error', 'Pending editor saves did not complete.', { error: errorRecord(error) });
    return (await ask({ duringClose: true, message: message('ui.pending_changes_could_not_be_saved'), buttons: [message('ui.cancel'), message('ui.retry'), message('quit.anyway')] })).response;
  },
  work: async () => {
    if (service.managing && (await ask({ duringClose: true, message: message('ui.cancel_the_installation_or_verification_and_quit'), buttons: [message('ui.keep_working'), message('ui.cancel_and_quit')] })).response !== 1) return false;
    if (service.queue.busy() && (await ask({ duringClose: true, message: message('ui.cancel_the_remaining_work_and_quit'), buttons: [message('ui.keep_working'), message('ui.cancel_work_and_quit')] })).response !== 1) return false;
    return true;
  },
  // Every step draws on the close's one deadline, which ends the process if they run late.
  finish: async () => {
    await service.stopManaged();
    await service.queue.stop();
    await service.settled();
    await backup?.close();
    logs?.close();
    records?.write('info', 'PicPatch closed normally.');
    await records?.close();
  },
  quit: () => { quitting = true; app.quit(); },
  failed: async error => {
    records?.write('error', 'Closing did not complete.', { error: errorRecord(error) });
    try { await ask({ duringClose: true, message: message('ui.picpatch_could_not_finish_closing'), buttons: [message('ui.keep_working')] }); }
    catch { /* No usable message surface: ordinary quit remains cancelled. */ }
  },
  interrupt: () => { quitting = true; command('shutdown'); requests.cancelAll(); service?.cancelManaged(); void service?.queue.stop(); },
  shutdownSave: async () => { await requests.request({ kind: 'flush' }); await service.settled(); },
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
  // A close aborts a window load still in progress; the close's own exit ends the process.
  if (closing || quitting) return;
  quitting = true; clearTimeout(smokeTimer); requests.cancelAll();
  window?.destroy(); logs?.close();
  await Promise.allSettled([backup?.terminate(), records?.close()]);
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
  await bootstrapLanguage(startupSettings!.language);
  records = new Records(paths.root, locations.worker('records-worker'), () => logs?.changed());
  records.write('info', 'PicPatch started.', { version: app.getVersion() });
  process.on('uncaughtExceptionMonitor', error => records?.write('error', 'Uncaught exception.', { error: errorRecord(error) }));
  backup = new Backup(paths.backups, locations.worker('backup-worker'), issue => {
    if (!service) return;
    if (issue.kind === 'unavailable') { service.historyIssue = new UiError('ui.backup_history_is_unavailable_primary_session_saves_remain_active'); window?.webContents.send('picpatch:changed'); return; }
    records?.write('warn', 'Backup capture failed.', { diagnostic: issue.diagnostic });
    service.historyIssue = new UiError('ui.backup_history_could_not_capture_some_work_primary_session'); window?.webContents.send('picpatch:changed');
  });
  const changed = (scope?: 'progress' | 'managed') => {
    if (scope === 'progress') window?.webContents.send('picpatch:queue', service?.queue.snapshot());
    else if (scope === 'managed') window?.webContents.send('picpatch:managed', service?.managedState);
    else window?.webContents.send('picpatch:changed');
  };
  service = await Application.open(paths, changed, (path, bytes) => backup?.capture(path, bytes), (level, message, details) => records?.write(level, message, details), startupSettings!);
  protocol.handle('picpatch-image', async request => {
    try {
      const url = new URL(request.url); const path = await service.sessions.imagePath(url.hostname, url.pathname.slice(1));
      // Session images never change after they are written, so the window may keep a thumbnail for as long as it is open.
      if (url.searchParams.get('size') === String(thumbnailSize)) return new Response(new Uint8Array(await thumbnails.get(path)), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' } });
      const response = await net.fetch(pathToFileURL(path).href); const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*'); return new Response(response.body, { status: response.status, headers });
    }
    catch { return new Response('Image unavailable', { status: 404 }); }
  });
  logs = new LogsWindow(records, () => ({ locale: localeState(), dark: nativeTheme.shouldUseDarkColors, uiFont: service.settings.uiFont, uiZoom: paneState?.uiZoom, listWidth: paneState?.recordsListWidth, timeZone: service.settings.timeZone }), error => records?.readFailed(error), width => storePane({ recordsListWidth: width }));
  const renderer = locations.page('index');
  ipcMain.handle('picpatch:call', async (event, action: string, payload: unknown) => {
    if (!trustedSender(event, window, renderer)) throw new Error('Untrusted request.');
    try {
      if (!['ready', 'listening', 'renderer-error', 'overview', 'get', 'draft', 'layout', 'paneState', 'savePane', 'modalState', 'focus'].includes(action)) records?.write('info', 'Command requested.', { action });
      // Every action reads named fields from one object; anything else is refused before it reaches one.
      if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) throw new Error('Invalid request.');
      return { ok: true, value: await dispatch(action, payload ?? {}) };
    }
    catch (error) { records?.write(isPicPatchSdkError(error) && error.kind === 'cancelled' ? 'info' : 'error', 'Command did not complete.', { action, error: errorRecord(error) }); return { ok: false, message: errorText(error), ...(isPicPatchSdkError(error) ? { code: error.code, kind: error.kind, effect: error.effect } : {}), notice: errorNotice(error) }; }
  });
  paneState = await readPaneState(paths.state);
  nativeTheme.themeSource = service.settings.theme ?? 'system';
  nativeTheme.on('updated', () => { logs?.updateAppearance(); window?.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors)); if (rendererReady) window?.webContents.send('picpatch:changed'); });
  menus();
  window = new BrowserWindow({ name: 'picpatch-main', windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' }, width: 1280, height: 850, minWidth: minimum(false).width, minHeight: minimum(false).height, title: 'PicPatch', ...(process.platform === 'darwin' ? {} : { icon: locations.icon() }), show: false, backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors), webPreferences: { zoomFactor: normalizeZoom(paneState.uiZoom), preload: locations.preload('index'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
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
function pick(properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string, initialPath?: string) {
  return pickPaths(window!, properties, title, initialPath);
}
/**
 * A model or engine operation that has started answers its request at once; its progress and terminal result reach
 * every view through application state, so closing the view that asked changes nothing. A refusal to start still
 * answers the request as an error.
 */
function started(task: Promise<unknown>): { started: true } { task.catch(() => {}); return { started: true }; }
async function dispatch(action: string, payload: any) {
  switch (action) {
    case 'modalState': modalOpen = payload.open === true; for (const id of ['picpatch-about','picpatch-settings']) { const item = Menu.getApplicationMenu()?.getMenuItemById(id); if (item) item.enabled = !modalOpen; } return;
    case 'closeWindow': void lifetime.close(); return;
    case 'openProjectLink': { if (payload.destination !== 'repository' && payload.destination !== 'issues') throw new Error('Unknown project link.'); await shell.openExternal(about[payload.destination as 'repository' | 'issues']); return; }
    case 'openLogs': try { await logs?.open(); } catch (error) { records?.write('error', 'Logs window could not open.', { error: errorRecord(error) }); throw new UiError('logs.openFailed'); } return;
    case 'listening': rendererReady = true; return;
    case 'renderer-error': records?.write('error', 'Renderer error.', { error: typeof payload.message === 'string' ? payload.message : 'unknown', stack: typeof payload.stack === 'string' ? payload.stack : undefined }); return;
    case 'ready': rendererReady = true; if (smoke) await finishSmoke(); return;
    case 'paneState': return paneState;
    case 'savePane': await storePane({ railWidth: payload.railWidth, optionsPane: payload.optionsPane }); return;
    case 'layout': { const size = minimum(payload.optionsPane === true); contentFloor = { width: size.width, height: Number.isFinite(payload.height) ? Math.max(size.height, payload.height) : size.height }; fitMinimum(); return; }
    case 'uiZoom': {
      if (!['in', 'out', 'reset'].includes(payload.direction)) throw new Error('Invalid UI zoom command.');
      const zoom = nextZoom(window!.webContents.getZoomFactor(), payload.direction);
      window!.webContents.setZoomFactor(zoom); fitMinimum();
      await storePane({ uiZoom: zoom }).catch(error => records?.write('warn', 'UI zoom could not be retained.', { error: errorRecord(error) })); logs?.updateAppearance(); return;
    }
    case 'locale': return { ...localeState(), uiFont: service.settings.uiFont };
    case 'modelReadiness': return service.readiness();
    case 'overview': return { ...await service.overview(), locale: localeState(), systemDark: systemDark() };
    case 'create': return service.create(t('session.untitled'));
    case 'get': service.sessions.focus(payload.id); return service.sessions.get(payload.id);
    case 'focus': service.queue.focus(typeof payload.id === 'string' ? payload.id : undefined); return;
    case 'draft': return service.draft(payload.id, payload.draft as Draft);
    case 'rename': if (typeof payload.name !== 'string' || !payload.name.trim()) throw new UiError('ui.enter_a_session_name'); return service.sessions.update(payload.id, session => { session.name = payload.name; });
    case 'delete': { if (service.queue.busy(payload.id)) throw new UiError('error.cancel_this_sessions_work_before_deleting_it'); const answer = await ask({ message: message('ui.delete_this_session_and_its_retained_images'), detail: message('ui.exported_images_and_original_files_are_kept'), buttons: [message('ui.keep_session'), message('ui.delete_session')] }); if (answer.response !== 1) return false; return { removed: true, ...await service.remove(payload.id) }; }
    case 'import': { const files = payload.path ? [payload.path] : await pick(payload.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'], t('ui.add_images')); if (closing) throw new UiError('ui.wait_for_the_current_managed_operation_or_cancel_it'); return service.importImages(payload.id, files); }
    case 'mask': return service.mask(payload.id, payload.bytes);
    case 'submit': return service.submit(payload.id, payload.draft, payload.samples);
    case 'cancel': return service.queue.cancel(payload.id, payload.runId);
    case 'resume': return service.resume(payload.id);
    case 'export': {
      const defaultPath = exportDefaultPath(await service.sessions.get(payload.id), payload.runId, paneState.exportDirectory);
      const result = await dialog.showSaveDialog(window!, { title: t('ui.save_image'), defaultPath, filters: [{ name: t('ui.png_image'), extensions: ['png'] }] });
      if (result.canceled || !result.filePath) return;
      const saved = await service.export(payload.id, payload.runId, result.filePath, payload.sidecar === true, payload.includeInputs === true);
      if (saved.status === 'completed') await storePane({ exportDirectory: dirname(result.filePath) }).catch(error => records?.write('warn', 'Export destination could not be retained.', { error: errorRecord(error) }));
      return saved;
    }
    case 'cancelManaged': service.cancelManaged(); return;
    case 'preferences': await service.preferences(payload); nativeTheme.themeSource = service.settings.theme ?? 'system'; await selectLanguage(service.settings.language); menus(); logs?.updateAppearance(); window?.webContents.send('picpatch:changed'); return service.overview();
    case 'pickPath': return (await pick([payload.file ? 'openFile' : 'openDirectory'], t('ui.choose_location'), payload.initialPath))[0];
    case 'pickComponent': return pickBundleComponent(window!, payload.directory, payload.current, t('ui.choose_a_file_inside_the_model_bundle'));
    case 'verify': return started(service.verify(payload.modelId));
    case 'removeManaged': {
      const answer = await ask({ message: message('ui.remove_this_managed_model_revision'), detail: message('ui.other_apps_using_this_shared_model_may_fail_sessions'), buttons: [message('ui.keep_model'), message('ui.remove_revision')] });
      if (answer.response === 1) return started(service.removeManaged(payload.modelId, payload.name)); return;
    }
    case 'models': return service.models();
    case 'prepare': {
      if (payload.download) {
        const model = downloadableModel(payload.modelId);
        const size = number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 });
        const answer = await ask({ message: message('management.download', { model: model.profile.name }), detail: message('management.downloadScope', { size }), buttons: [message('ui.cancel'), message('ui.download')], destructive: false });
        if (answer.response !== 1) return;
        return started(service.prepare(model.id, undefined, undefined, true, {}));
      }
      // Native bundles name their checkpoint through pickComponent before Register is enabled.
      const paths = payload.directory ? [payload.directory] : await pick(['openDirectory'], t('ui.select_the_model_bundle')); if (!paths[0]) return;
      return started(service.prepare(payload.modelId, paths[0], payload.checkpoint, false, payload.components));
    }
    case 'engines': return service.engines(payload.modelId);
    case 'installNative': return started(service.installNative(payload.modelId));
    case 'installPython': return started(service.installPython(payload.modelId, locations.uv(), pythonToolDirectories(process.env.PATH, delimiter)));
    case 'collection': { const paths = await pick(['openDirectory'], t('ui.open_sessions_collection'), service.sessions.root); if (!paths[0]) return false; await service.collection(paths[0]); return true; }
    default: throw new Error('Unknown action.');
  }
}

async function finishSmoke() {
  const code = await runSmoke({
    window: window!, packaged: app.isPackaged,
    ...(localizationSmoke ? { localization: { root: paths.root, command, openLogs: () => logs!.open(false), closeLogs: () => logs!.close() } } : {}),
    ...(qualification ? { inference: { service, configuration: qualification, uv: locations.uv() } } : {}),
  });
  if (code === 0) { clearTimeout(smokeTimer); await backup?.terminate(); await records?.close(); }
  app.exit(code);
}
let modalOpen = false;
function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform === 'darwin', app.isPackaged, modalOpen, command, () => {
    const focused = BrowserWindow.getFocusedWindow(); if (focused && focused !== window) focused.close(); else command('closeWindow');
  })));
}
