import { about } from '../shared/about.ts';
import { normalizeZoom, nextZoom, windowMinimum } from '../shared/appearance.ts';
import type { PaneState } from '../app/layout-state.ts';
import { accelerator, shortcutCommand } from '../shared/shortcuts.ts';
import { rendererRequests } from './renderer-requests.ts';
import { quitFlow } from './quit.ts';
import type { Message } from '../shared/i18n/index.ts';
import { bootstrapLanguage, selectLanguage, localeState, prepareChromiumLanguage } from './language.ts';
import { t, term, number, errorText, errorNotice, UiError, message } from '../shared/i18n/index.ts';
import { Records, errorRecord } from '../app/records.ts';
import { readPaneState, savePaneState } from '../app/layout-state.ts';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, powerMonitor, nativeTheme, systemPreferences, screen, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename, relative, isAbsolute, delimiter } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { qualifyInference, qualifyLocalization } from './qualification.ts';
import { installEngine, installNativeEngine, inspectEngine, inspectNativeEngine, isPicPatchSdkError } from 'picpatchsdk';
import { appPaths, resolveAppPaths } from '../app/paths.ts';
import { Application } from '../app/service.ts';
import { minimum } from '../shared/layout.ts';
import type { Draft } from '../app/types.ts';
app.setName('PicPatch');
prepareChromiumLanguage(resolveAppPaths().config);
const here = dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: 'picpatch-image', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window: BrowserWindow | undefined; let service: Application; let quitting = false;
let backup: Worker | undefined;
let records: Records | undefined;
let managed: { controller: AbortController; task: Promise<unknown> } | undefined;
const paths = await appPaths();
app.setPath('userData', paths.root); app.setPath('sessionData', join(paths.root, 'browser'));
await mkdir(join(paths.root, 'browser'), { recursive: true, mode: 0o700 });
const qualificationIndex = process.argv.indexOf('--smoke-inference');
const qualification = qualificationIndex < 0 ? undefined : process.argv[qualificationIndex + 1];
const localizationSmoke = process.argv.includes('--smoke-localization');
const smoke = process.argv.includes('--smoke') || qualificationIndex >= 0 || localizationSmoke;
let smokeTimer: ReturnType<typeof setTimeout> | undefined;
let paneState: PaneState;
let paneWrites = Promise.resolve();
let contentFloor = minimum(false);
let appliedMinimum = '';
function storePane(patch: Partial<PaneState>) {
  paneState = { ...paneState, ...patch };
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
  if (event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame) requests.reply(reply);
});
async function ask(options: { message: Message; detail?: Message; buttons: Message[]; destructive?: boolean; duringClose?: boolean }) {
  if (closing && !options.duringClose) return { response: undefined };
  const response = await requests.request({ kind: 'message', message: {
    title: options.message, detail: options.detail,
    actions: options.buttons.map((label, index) => ({ label, destructive: options.destructive !== false && index > 0 && index === options.buttons.length - 1 })),
  } });
  return { response };
}
const lifetime = quitFlow({
  freeze: value => { closing = value; command(value ? 'beginClose' : 'endClose'); },
  flush: async () => { await requests.request({ kind: 'flush' }, 5000); },
  drafts: async () => await requests.request({ kind: 'closeDrafts' }) === true,
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
    if (backup) { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); const done = (reply: any) => { if (reply.flushed === 'quit') { clearTimeout(timer); backup?.off('message', done); resolve(); } }; backup!.on('message', done); backup!.postMessage({ flush: 'quit' }); }); await backup.terminate(); }
    records?.write('info', 'PicPatch closed normally.'); await records?.close();
    quitting = true; app.quit();
  },
  failed: async error => {
    records?.write('error', 'Closing did not complete.', { error: errorRecord(error) });
    try { await ask({ duringClose: true, message: message('ui.picpatch_could_not_finish_closing'), buttons: [message('ui.keep_working')] }); }
    catch { /* No usable message surface: ordinary quit remains cancelled. */ }
  },
  interrupt: () => { quitting = true; command('shutdown'); requests.cancelAll(); managed?.controller.abort(); },
  shutdownSave: async () => { await requests.request({ kind: 'flush' }, 800); await service.sessions.settled(); },
  exit: () => app.exit(0),
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { window?.show(); });
  void app.whenReady().then(start).catch(startupFailure);
}
// Existing pre-workspace fallback: the app message host is unavailable if startup fails.
async function startupFailure(error: unknown) {
  await dialog.showMessageBox({ type: 'error', message: t('ui.picpatch_could_not_start'), detail: errorText(error) });
  app.exit(1);
}
function command(id: string) { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('picpatch:command', id); }
async function start() {
  await bootstrapLanguage(paths.config);
  records = new Records(paths.root, join(here, 'records-worker.mjs'));
  records.write('info', 'PicPatch started.', { version: app.getVersion() });
  process.on('uncaughtExceptionMonitor', error => records?.write('error', 'Uncaught exception.', { error: errorRecord(error) }));
  backup = new Worker(join(here, 'backup-worker.mjs'));
  backup.on('error', () => { if (service) service.historyIssue = new UiError('ui.backup_history_is_unavailable_primary_session_saves_remain_active'); });
  backup.on('message', message => { if (message.issue && service) { records?.write('warn', 'Backup capture failed.', { diagnostic: message.issue }); service.historyIssue = new UiError('ui.backup_history_could_not_capture_some_work_primary_session'); window?.webContents.send('picpatch:changed'); } });
  service = await Application.open(paths, () => window?.webContents.send('picpatch:changed'), (path, bytes, sha256) => backup?.postMessage({ database: paths.backups, path, bytes, sha256 }), (level, message, details) => records?.write(level, message, details));
  protocol.handle('picpatch-image', async request => {
    try { const url = new URL(request.url); const path = await service.sessions.imagePath(url.hostname, url.pathname.slice(1)); const response = await net.fetch(pathToFileURL(path).href); const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*'); return new Response(response.body, { status: response.status, headers }); }
    catch { return new Response('Image unavailable', { status: 404 }); }
  });
  const renderer = pathToFileURL(join(here, 'index.html')).href;
  ipcMain.handle('picpatch:call', async (event, action: string, payload: any = {}) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== renderer) throw new Error('Untrusted request.');
    try {
      if (!['ready', 'overview', 'get', 'draft', 'layout', 'paneState', 'records'].includes(action)) records?.write('info', 'Command requested.', { action });
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
  nativeTheme.on('updated', () => { window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17191c' : '#f4f4f2'); if (rendererReady) window?.webContents.send('picpatch:changed'); });
  menus();
  window = new BrowserWindow({ name: 'picpatch-main', windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' }, width: 1280, height: 850, minWidth: minimum(false).width, minHeight: minimum(false).height, title: 'PicPatch', ...(process.platform === 'darwin' ? {} : { icon: join(here, 'icon.png') }), show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191c' : '#f4f4f2', webPreferences: { zoomFactor: normalizeZoom(paneState.uiZoom), preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.on('move', fitMinimum);
  screen.on('display-metrics-changed', fitMinimum);
  fitMinimum();
  window.webContents.on('before-input-event', (_event, input) => { window?.webContents.setIgnoreMenuShortcuts(input.isComposing || shortcutCommand({ key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }) !== undefined); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== renderer) event.preventDefault(); });
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' picpatch-image: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"] } }));
  window.once('ready-to-show', () => { if (!smoke) window?.show(); });
  if (smoke) smokeTimer = setTimeout(() => { app.exit(1); }, qualification ? 300_000 : localizationSmoke ? 60_000 : 15000);
  window.on('close', event => { if (!quitting) { event.preventDefault(); void lifetime.close(); } });
  process.on('SIGTERM', () => lifetime.shutdown());
  window.on('query-session-end', () => lifetime.shutdown());
  window.on('session-end', () => lifetime.shutdown());
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void lifetime.close(); } });
  powerMonitor.on('shutdown', () => { records?.write('info', 'OS shutdown requested.'); lifetime.shutdown(); });
  window.webContents.on('render-process-gone', () => { rendererReady = false; requests.cancelAll(); });
  window.webContents.on('did-start-loading', () => { rendererReady = false; requests.cancelAll(); });
  window.on('closed', () => { rendererReady = false; requests.cancelAll(); });
  await window.loadURL(renderer);
}
async function pick(properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string) {
  const result = await dialog.showOpenDialog(window!, { title, properties }); return result.canceled ? [] : result.filePaths;
}
async function dispatch(action: string, payload: any, signal?: AbortSignal) {
  switch (action) {
    case 'closeWindow': void lifetime.close(); return;
    case 'openProjectLink': { if (payload.destination !== 'repository' && payload.destination !== 'issues') throw new Error('Unknown project link.'); await shell.openExternal(about[payload.destination as 'repository' | 'issues']); return; }
    case 'records': return records?.list() ?? [];
    case 'ready': rendererReady = true; if (smoke) { if (localizationSmoke) { try { await qualifyLocalization(window!, paths.root); } catch (error) { console.error(error); app.exit(1); return; } } if (qualification) { try { await qualifyInference(service, qualification, join(here, 'tools/uv')); } catch (error) { console.error(error); app.exit(1); return; } } clearTimeout(smokeTimer); await backup?.terminate(); await records?.close(); app.exit(0); } return;
    case 'paneState': if (payload.requestWidth !== undefined) { await storePane({ requestWidth: payload.requestWidth, sidebar: payload.sidebar }); return; } return paneState;
    case 'layout': { const size = minimum(payload.sidebar === true); contentFloor = { width: size.width, height: Number.isFinite(payload.height) ? Math.max(size.height, payload.height) : size.height }; fitMinimum(); return; }
    case 'uiZoom': {
      if (!['in', 'out', 'reset'].includes(payload.direction)) throw new Error('Invalid UI zoom command.');
      const zoom = nextZoom(window!.webContents.getZoomFactor(), payload.direction);
      window!.webContents.setZoomFactor(zoom); fitMinimum();
      await storePane({ uiZoom: zoom }).catch(error => records?.write('warn', 'UI zoom could not be retained.', { error: errorRecord(error) })); return;
    }
    case 'locale': return { ...localeState(), uiFont: service.settings.uiFont };
    case 'overview': return { ...await service.overview(), locale: localeState(), systemDark: systemDark() };
    case 'create': return service.sessions.create(t('session.untitled'));
    case 'get': return service.sessions.get(payload.id);
    case 'draft': return service.draft(payload.id, payload.draft as Draft);
    case 'rename': if (typeof payload.name !== 'string' || !payload.name.trim()) throw new UiError('ui.enter_a_session_name'); return service.sessions.update(payload.id, session => { session.name = payload.name; });
    case 'delete': { const answer = await ask({ message: message('ui.delete_this_session_and_its_retained_images'), detail: message('ui.exported_images_and_original_files_are_kept'), buttons: [message('ui.keep_session'), message('ui.delete_session')] }); if (answer.response !== 1) return false; await service.remove(payload.id); return true; }
    case 'import': { const files = payload.path ? [payload.path] : await pick(['openFile', 'multiSelections'], t('ui.add_images')); const assets = []; for (const path of files) assets.push(await service.importImage(payload.id, path)); return assets; }
    case 'mask': return service.mask(payload.id, payload.bytes);
    case 'submit': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); return service.queue.submit(payload.id, payload.draft, payload.samples, payload.parent);
    case 'cancel': return service.queue.cancel(payload.id, payload.runId);
    case 'resume': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); return service.queue.resume(payload.id);
    case 'export': { const result = await dialog.showSaveDialog(window!, { title: t('ui.save_image'), defaultPath: 'image.png', filters: [{ name: t('ui.png_image'), extensions: ['png'] }] }); if (result.canceled || !result.filePath) return; return service.export(payload.id, payload.runId, result.filePath, payload.sidecar === true, payload.includeInputs === true); }
    case 'cancelManaged': managed?.controller.abort(); return;
    case 'preferences': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); await service.preferences(payload); nativeTheme.themeSource = service.settings.theme ?? 'system'; await selectLanguage(service.settings.language); menus(); window?.webContents.send('picpatch:changed'); return service.overview();
    case 'pickPath': return (await pick([payload.file ? 'openFile' : 'openDirectory'], t('ui.choose_location')))[0];
    case 'pickComponent': {
      if (typeof payload.directory !== 'string' || !isAbsolute(payload.directory)) throw new UiError('ui.choose_the_model_bundle_first');
      const file = (await pick(['openFile'], t('ui.choose_a_file_inside_the_model_bundle')))[0]; if (!file) return;
      const path = relative(payload.directory, file); if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new UiError('ui.choose_a_file_inside_the_selected_bundle'); return path;
    }
    case 'verify': return service.verify(payload.modelId, signal);
    case 'removeManaged': {
      const answer = await ask({ message: message('ui.remove_this_managed_model_revision'), detail: message('ui.other_apps_using_this_shared_model_may_fail_sessions'), buttons: [message('ui.keep_model'), message('ui.remove_revision')] });
      if (answer.response === 1) return service.removeManaged(payload.modelId, payload.name, signal); return;
    }
    case 'models': return service.models();
    case 'prepare': { if (payload.download) { const model = (await service.overview()).models.find(m => m.id === payload.modelId); if (!model || model.acquisition !== 'pinned') throw new UiError('ui.no_downloadable_bundle_for_this_selection'); const answer = await ask({ message: message('management.download', { model: model.id }), detail: message('management.downloadScope', { size: number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 }) }), buttons: [message('ui.cancel'), message('ui.download')], destructive: false }); if (answer.response !== 1) return; return service.prepare(model.id, undefined, undefined, true, {}, signal); }
      const paths = payload.directory ? [payload.directory] : await pick(['openDirectory'], t('ui.select_the_model_bundle')); if (!paths[0]) return; let checkpoint: string | undefined = payload.checkpoint;
      if (!checkpoint && (await service.overview()).models.find(m => m.id === payload.modelId)?.runtime.name === 'stable-diffusion.cpp') { const files = await pick(['openFile'], t('ui.select_the_checkpoint_inside_that_bundle')); if (!files[0] || dirname(files[0]) !== paths[0]) throw new UiError('ui.choose_a_checkpoint_in_the_selected_bundle'); checkpoint = basename(files[0]); }
      return service.prepare(payload.modelId, paths[0], checkpoint, false, payload.components, signal); }
    case 'engines': return { mflux: await inspectEngine({ profile: service.settings.profile, onEvent: service.sdkEvents({ action }) }), native: await inspectNativeEngine({ profile: service.settings.profile, onEvent: service.sdkEvents({ action }) }) };
    case 'installNative': return installNativeEngine({ onEvent: service.sdkEvents({ action }), profile: service.settings.profile, signal });
    case 'installPython': { const uvExecutable = app.isPackaged ? join(here, 'tools/uv') : join(here, '../node_modules/.cache/picpatch-desktop/uv-0.13.1/uv-aarch64-apple-darwin/uv'); return installEngine({ onEvent: service.sdkEvents({ action }), profile: service.settings.profile, uvExecutable, toolDirectories: [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), '/opt/homebrew/bin', '/usr/local/bin'])], signal }); }
    case 'collection': { const paths = await pick(['openDirectory'], t('ui.open_sessions_collection')); if (!paths[0]) return false; await service.collection(paths[0]); return true; }
    default: throw new Error('Unknown action.');
  }
}

function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PicPatch', submenu: [{ label: t('ui.settings'), accelerator: accelerator('settingsButton'), click: () => command('settingsButton') }, { type: 'separator' }, { label: t('ui.about_picpatch'), click: () => command('about') }, { type: 'separator' }, { role: 'services', label: t('native.services') }, { role: 'hide', label: t('native.hide') }, { role: 'hideOthers', label: t('native.hideOthers') }, { role: 'unhide', label: t('native.showAll') }, { type: 'separator' }, { label: t('native.quit'), accelerator: accelerator('quit'), click: () => command('quit') }] },
    { label: t('ui.file'), submenu: [{ label: t('ui.new_session_2'), accelerator: accelerator('new'), click: () => command('new') }, { label: t('ui.open_source_image'), accelerator: accelerator('import'), click: () => command('import') }, { label: t('ui.save_image_2'), accelerator: accelerator('save'), click: () => command('save') }, { label: t('ui.save_image_with_settings'), accelerator: accelerator('saveSettings'), click: () => command('saveSettings') }, { type: 'separator' }, { label: t('ui.generate_or_edit'), accelerator: accelerator('run'), click: () => command('run') }] },
    { label: t('native.edit'), submenu: [{ role: 'undo', label: t('native.undo') }, { role: 'redo', label: t('native.redo') }, { type: 'separator' }, { role: 'cut', label: t('native.cut') }, { role: 'copy', label: t('native.copy') }, { role: 'paste', label: t('native.paste') }, { role: 'pasteAndMatchStyle', label: t('native.pasteMatch') }, { role: 'delete', label: t('native.delete') }, { role: 'selectAll', label: t('native.selectAll') }] },
    { label: t('native.view'), submenu: [{ label: t('shortcuts.title'), accelerator: accelerator('shortcutsButton'), click: () => command('shortcutsButton') }, { type: 'separator' }, { role: 'reload', label: t('native.reload') }, { role: 'forceReload', label: t('native.forceReload') }, { role: 'toggleDevTools', label: t('native.developerTools') }, { type: 'separator' }, { label: t('native.zoomIn'), accelerator: accelerator('uiZoomIn'), click: () => command('uiZoomIn') }, { label: t('native.zoomOut'), accelerator: accelerator('uiZoomOut'), click: () => command('uiZoomOut') }, { label: t('native.resetZoom'), accelerator: accelerator('uiZoomReset'), click: () => command('uiZoomReset') }, { role: 'togglefullscreen', label: t('native.fullscreen') }] },
    { label: t('native.window'), role: 'windowMenu', submenu: [{ role: 'minimize', label: t('native.minimize') }, { label: t('native.close'), accelerator: accelerator('closeWindow'), click: () => command('closeWindow') }, { role: 'zoom', label: t('native.zoomWindow') }, { role: 'front', label: t('native.bringAllFront') }] },
  ]));
}
