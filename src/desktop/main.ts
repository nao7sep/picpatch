import { bootstrapLanguage, selectLanguage, localeState, prepareChromiumLanguage } from './language.ts';
import { t, term, number, errorText, errorNotice, UiError } from '../shared/i18n/index.ts';
import { Records, errorRecord } from '../app/records.ts';
import { readPaneState, savePaneState } from '../app/layout-state.ts';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, powerMonitor } from 'electron';
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
let window: BrowserWindow | undefined; let service: Application; let quitting = false; let closing = false;
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
let flushReply: ((reply: { ok: boolean; message?: string }) => void) | undefined;
ipcMain.on('picpatch:flushed', (event, reply) => { if (event.sender === window?.webContents) flushReply?.(reply); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { window?.show(); });
  void app.whenReady().then(start).catch(async error => { await dialog.showMessageBox({ type: 'error', message: t('ui.picpatch_could_not_start'), detail: errorText(error) }); app.exit(1); });
}
function command(id: string) { window?.webContents.send('picpatch:command', id); }
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
  menus();
  window = new BrowserWindow({ name: 'picpatch-main', windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' }, width: 1280, height: 850, minWidth: minimum(false).width, minHeight: minimum(false).height, title: 'PicPatch', icon: join(here, 'icon.png'), show: false, backgroundColor: '#17191c', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== renderer) event.preventDefault(); });
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' picpatch-image: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"] } }));
  window.once('ready-to-show', () => { if (!smoke) window?.show(); });
  if (smoke) smokeTimer = setTimeout(() => { app.exit(1); }, qualification ? 300_000 : localizationSmoke ? 60_000 : 15000);
  window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
  process.on('SIGTERM', () => { void close(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void close(); } });
  powerMonitor.on('shutdown', () => { records?.write('info', 'OS shutdown requested.'); quitting = true; managed?.controller.abort(); service.queue.stop().catch(() => {}); app.exit(0); });
  await window.loadURL(renderer);
}
async function close() {
  if (closing) return; closing = true;
  try {
    for (;;) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { flushReply = undefined; reject(new UiError('ui.the_editor_did_not_confirm_its_pending_draft_save')); }, 5000);
          flushReply = reply => { clearTimeout(timer); flushReply = undefined; if (reply.ok) resolve(); else reject(new Error(reply.message)); };
          window?.webContents.send('picpatch:flush');
        });
        break;
      } catch (error) {
        const answer = await dialog.showMessageBox(window!, { message: t('ui.pending_changes_could_not_be_saved'), detail: errorText(error), buttons: [t('ui.keep_working'), t('ui.retry_save'), t('ui.quit_without_pending_changes')], defaultId: 0, cancelId: 0 });
        if (answer.response === 0) return;
        if (answer.response === 2) break;
      }
    }
    if (managed) { const result = await dialog.showMessageBox(window!, { message: t('ui.cancel_the_installation_or_verification_and_quit'), buttons: [t('ui.keep_working'), t('ui.cancel_and_quit')], defaultId: 0, cancelId: 0 }); if (result.response === 0) return; const pending = managed; pending.controller.abort(); await pending.task.catch(() => {}); }
    if (service.queue.busy()) { const result = await dialog.showMessageBox(window!, { message: t('ui.cancel_the_remaining_work_and_quit'), buttons: [t('ui.keep_working'), t('ui.cancel_work_and_quit')], defaultId: 0, cancelId: 0 }); if (result.response === 0) return; }
    await service.queue.stop(); await service.sessions.settled();
    quitting = true;
    if (backup) { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); const done = (message: any) => { if (message.flushed === 'quit') { clearTimeout(timer); backup?.off('message', done); resolve(); } }; backup!.on('message', done); backup!.postMessage({ flush: 'quit' }); }); await backup.terminate(); }
    records?.write('info', 'PicPatch closed normally.'); await records?.close();
    app.quit();
  } catch (error) { await dialog.showMessageBox(window!, { message: t('ui.picpatch_could_not_finish_closing'), detail: errorText(error) }); }
  finally { closing = false; }
}
async function pick(properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string) {
  const result = await dialog.showOpenDialog(window!, { title, properties }); return result.canceled ? [] : result.filePaths;
}
async function dispatch(action: string, payload: any, signal?: AbortSignal) {
  switch (action) {
    case 'records': return records?.list() ?? [];
    case 'ready': if (smoke) { if (localizationSmoke) { try { await qualifyLocalization(window!, paths.root); } catch (error) { console.error(error); app.exit(1); return; } } if (qualification) { try { await qualifyInference(service, qualification, join(here, 'tools/uv')); } catch (error) { console.error(error); app.exit(1); return; } } clearTimeout(smokeTimer); await backup?.terminate(); await records?.close(); app.exit(0); } return;
    case 'paneState': if (payload.requestWidth !== undefined) { await savePaneState(paths.state, payload); return; } return readPaneState(paths.state);
    case 'layout': { const size = minimum(payload.sidebar === true); const [outerWidth, outerHeight] = window!.getSize(); const [contentWidth, contentHeight] = window!.getContentSize(); const height = Number.isFinite(payload.height) ? Math.max(size.height, payload.height) : size.height; window!.setMinimumSize(size.width + outerWidth - contentWidth, height + outerHeight - contentHeight); return; }
    case 'locale': return localeState();
    case 'overview': return { ...await service.overview(), locale: localeState() };
    case 'create': return service.sessions.create(t('session.untitled'));
    case 'get': return service.sessions.get(payload.id);
    case 'draft': return service.draft(payload.id, payload.draft as Draft);
    case 'rename': if (typeof payload.name !== 'string' || !payload.name.trim()) throw new UiError('ui.enter_a_session_name'); return service.sessions.update(payload.id, session => { session.name = payload.name; });
    case 'delete': { const answer = await dialog.showMessageBox(window!, { message: t('ui.delete_this_session_and_its_retained_images'), detail: t('ui.exported_images_and_original_files_are_kept'), buttons: [t('ui.keep_session'), t('ui.delete_session')], cancelId: 0, defaultId: 0 }); if (answer.response === 1) await service.remove(payload.id); return; }
    case 'import': { const files = payload.path ? [payload.path] : await pick(['openFile', 'multiSelections'], t('ui.add_images')); const assets = []; for (const path of files) assets.push(await service.importImage(payload.id, path)); return assets; }
    case 'mask': return service.mask(payload.id, payload.bytes);
    case 'submit': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); return service.queue.submit(payload.id, payload.draft, payload.samples, payload.parent);
    case 'cancel': return service.queue.cancel(payload.id, payload.runId);
    case 'resume': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); return service.queue.resume(payload.id);
    case 'export': { const result = await dialog.showSaveDialog(window!, { title: t('ui.save_image'), defaultPath: 'image.png', filters: [{ name: t('ui.png_image'), extensions: ['png'] }] }); if (result.canceled || !result.filePath) return; return service.export(payload.id, payload.runId, result.filePath, payload.sidecar === true, payload.includeInputs === true); }
    case 'cancelManaged': managed?.controller.abort(); return;
    case 'preferences': if (managed) throw new UiError('ui.wait_for_the_current_resource_operation'); await service.preferences(payload); await selectLanguage(service.settings.language); menus(); window?.webContents.send('picpatch:changed'); return service.overview();
    case 'pickPath': return (await pick([payload.file ? 'openFile' : 'openDirectory'], t('ui.choose_location')))[0];
    case 'pickComponent': {
      if (typeof payload.directory !== 'string' || !isAbsolute(payload.directory)) throw new UiError('ui.choose_the_model_bundle_first');
      const file = (await pick(['openFile'], t('ui.choose_a_file_inside_the_model_bundle')))[0]; if (!file) return;
      const path = relative(payload.directory, file); if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new UiError('ui.choose_a_file_inside_the_selected_bundle'); return path;
    }
    case 'verify': return service.verify(payload.modelId, signal);
    case 'removeManaged': {
      const answer = await dialog.showMessageBox(window!, { message: t('ui.remove_this_managed_model_revision'), detail: t('ui.other_apps_using_this_shared_model_may_fail_sessions'), buttons: [t('ui.keep_model'), t('ui.remove_revision')], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) return service.removeManaged(payload.modelId, payload.name, signal); return;
    }
    case 'models': return service.models();
    case 'prepare': { if (payload.download) { const model = (await service.overview()).models.find(m => m.id === payload.modelId); if (!model || model.acquisition !== 'pinned') throw new UiError('ui.no_downloadable_bundle_for_this_selection'); const answer = await dialog.showMessageBox(window!, { message: t('management.download', { model: model.id }), detail: t('management.downloadScope', { size: number(model.downloadBytes / 1e9, { maximumFractionDigits: 1 }) }), buttons: [t('ui.cancel'), t('ui.download')], cancelId: 0, defaultId: 0 }); if (answer.response !== 1) return; return service.prepare(model.id, undefined, undefined, true, {}, signal); }
      const paths = payload.directory ? [payload.directory] : await pick(['openDirectory'], t('ui.select_the_model_bundle')); if (!paths[0]) return; let checkpoint: string | undefined = payload.checkpoint;
      if (!checkpoint && (await service.overview()).models.find(m => m.id === payload.modelId)?.runtime.name === 'stable-diffusion.cpp') { const files = await pick(['openFile'], t('ui.select_the_checkpoint_inside_that_bundle')); if (!files[0] || dirname(files[0]) !== paths[0]) throw new UiError('ui.choose_a_checkpoint_in_the_selected_bundle'); checkpoint = basename(files[0]); }
      return service.prepare(payload.modelId, paths[0], checkpoint, false, payload.components, signal); }
    case 'engines': return { mflux: await inspectEngine({ profile: service.settings.profile, onEvent: service.sdkEvents({ action }) }), native: await inspectNativeEngine({ profile: service.settings.profile, onEvent: service.sdkEvents({ action }) }) };
    case 'installNative': return installNativeEngine({ onEvent: service.sdkEvents({ action }), profile: service.settings.profile, signal });
    case 'installPython': { const uvExecutable = app.isPackaged ? join(here, 'tools/uv') : join(here, '../node_modules/.cache/picpatch-desktop/uv-0.13.1/uv-aarch64-apple-darwin/uv'); return installEngine({ onEvent: service.sdkEvents({ action }), profile: service.settings.profile, uvExecutable, toolDirectories: [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), '/opt/homebrew/bin', '/usr/local/bin'])], signal }); }
    case 'collection': { const paths = await pick(['openDirectory'], t('ui.open_sessions_collection')); if (paths[0]) await service.collection(paths[0]); return; }
    default: throw new Error('Unknown action.');
  }
}

function menus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PicPatch', submenu: [{ label: t('ui.settings'), accelerator: 'CmdOrCtrl+,', click: () => command('settingsButton') }, { type: 'separator' }, { label: t('ui.about_picpatch'), click: () => { void dialog.showMessageBox(window!, { message: 'PicPatch', detail: t('ui.generate_and_refine_images_with_local_aigpl30orlater') }); } }, { type: 'separator' }, { role: 'services', label: t('native.services') }, { role: 'hide', label: t('native.hide') }, { role: 'hideOthers', label: t('native.hideOthers') }, { role: 'unhide', label: t('native.showAll') }, { type: 'separator' }, { role: 'quit', label: t('native.quit') }] },
    { label: t('ui.file'), submenu: [{ label: t('ui.new_session_2'), accelerator: 'CmdOrCtrl+N', click: () => command('new') }, { label: t('ui.open_source_image'), accelerator: 'CmdOrCtrl+O', click: () => command('import') }, { label: t('ui.save_image_2'), accelerator: 'CmdOrCtrl+S', click: () => command('save') }, { label: t('ui.save_image_with_settings'), accelerator: 'CmdOrCtrl+Shift+S', click: () => command('saveSettings') }, { type: 'separator' }, { label: t('ui.generate_or_edit'), accelerator: 'CmdOrCtrl+Enter', click: () => command('run') }] },
    { label: t('native.edit'), submenu: [{ role: 'undo', label: t('native.undo') }, { role: 'redo', label: t('native.redo') }, { type: 'separator' }, { role: 'cut', label: t('native.cut') }, { role: 'copy', label: t('native.copy') }, { role: 'paste', label: t('native.paste') }, { role: 'pasteAndMatchStyle', label: t('native.pasteMatch') }, { role: 'delete', label: t('native.delete') }, { role: 'selectAll', label: t('native.selectAll') }] },
    { label: t('native.view'), submenu: [{ role: 'reload', label: t('native.reload') }, { role: 'forceReload', label: t('native.forceReload') }, { role: 'toggleDevTools', label: t('native.developerTools') }, { type: 'separator' }, { role: 'zoomIn', label: t('native.zoomIn') }, { role: 'zoomOut', label: t('native.zoomOut') }, { role: 'resetZoom', label: t('native.resetZoom') }, { role: 'togglefullscreen', label: t('native.fullscreen') }] },
    { label: t('native.window'), role: 'windowMenu', submenu: [{ role: 'minimize', label: t('native.minimize') }, { role: 'close', label: t('native.close') }, { role: 'zoom', label: t('native.zoomWindow') }, { role: 'front', label: t('native.bringAllFront') }] },
  ]));
}
