import { Records, errorRecord } from '../app/records.ts';
import { readPaneState, savePaneState } from '../app/layout-state.ts';
import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, powerMonitor } from 'electron';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename, relative, isAbsolute, delimiter } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { qualifyInference } from './qualification.ts';
import { installEngine, installNativeEngine, inspectEngine, inspectNativeEngine } from 'picpatchsdk';
import { appPaths } from '../app/paths.ts';
import { Application } from '../app/service.ts';
import { minimum } from '../shared/layout.ts';
import type { Draft } from '../app/types.ts';
app.setName('PicPatch');
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
const smoke = process.argv.includes('--smoke') || qualificationIndex >= 0;
let smokeTimer: ReturnType<typeof setTimeout> | undefined;
let flushReply: ((reply: { ok: boolean; message?: string }) => void) | undefined;
ipcMain.on('picpatch:flushed', (event, reply) => { if (event.sender === window?.webContents) flushReply?.(reply); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { window?.show(); });
  void app.whenReady().then(start).catch(async error => { await dialog.showMessageBox({ type: 'error', message: 'PicPatch could not start.', detail: String(error) }); app.exit(1); });
}
function command(id: string) { window?.webContents.send('picpatch:command', id); }
async function start() {
  records = new Records(paths.root, join(here, 'records-worker.mjs'));
  records.write('info', 'PicPatch started.', { version: app.getVersion() });
  process.on('uncaughtExceptionMonitor', error => records?.write('error', 'Uncaught exception.', { error: errorRecord(error) }));
  backup = new Worker(join(here, 'backup-worker.mjs'));
  backup.on('error', () => { if (service) service.historyIssue = 'Backup history is unavailable; primary session saves remain active.'; });
  backup.on('message', message => { if (message.issue && service) { records?.write('warn', 'Backup capture failed.', { diagnostic: message.issue }); service.historyIssue = 'Backup history could not capture some work. Primary session saves remain active.'; window?.webContents.send('picpatch:changed'); } });
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
        if (managed) throw new Error('Wait for the current managed operation or cancel it.');
        const controller = new AbortController(); const task = dispatch(action, payload, controller.signal);
        managed = { controller, task };
        try { return { ok: true, value: await task }; } finally { managed = undefined; }
      }
      return { ok: true, value: await dispatch(action, payload) };
    }
    catch (error) { records?.write('error', 'Command failed.', { action, error: errorRecord(error) }); return { ok: false, message: error instanceof Error ? error.message : 'The operation could not finish.' }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PicPatch', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => command('settingsButton') }, { type: 'separator' }, { label: 'About PicPatch', click: () => { void dialog.showMessageBox(window!, { message: 'PicPatch', detail: 'Generate and refine images with local AI.\nGPL-3.0-or-later' }); } }, { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => command('new') }, { label: 'Open Source Image', accelerator: 'CmdOrCtrl+O', click: () => command('import') }, { label: 'Save Image', accelerator: 'CmdOrCtrl+S', click: () => command('save') }, { label: 'Save Image with Settings', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('saveSettings') }, { type: 'separator' }, { label: 'Generate or Edit', accelerator: 'CmdOrCtrl+Enter', click: () => command('run') }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  window = new BrowserWindow({ name: 'picpatch-main', windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' }, width: 1280, height: 850, minWidth: minimum(false).width, minHeight: minimum(false).height, title: 'PicPatch', icon: join(here, 'icon.png'), show: false, backgroundColor: '#17191c', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== renderer) event.preventDefault(); });
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' picpatch-image: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"] } }));
  window.once('ready-to-show', () => { if (!smoke) window?.show(); });
  if (smoke) smokeTimer = setTimeout(() => { app.exit(1); }, qualification ? 300_000 : 15000);
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
          const timer = setTimeout(() => { flushReply = undefined; reject(new Error('The editor did not confirm its pending draft save.')); }, 5000);
          flushReply = reply => { clearTimeout(timer); flushReply = undefined; if (reply.ok) resolve(); else reject(new Error(reply.message)); };
          window?.webContents.send('picpatch:flush');
        });
        break;
      } catch (error) {
        const answer = await dialog.showMessageBox(window!, { message: 'Pending changes could not be saved.', detail: String(error), buttons: ['Keep working', 'Retry save', 'Quit without pending changes'], defaultId: 0, cancelId: 0 });
        if (answer.response === 0) return;
        if (answer.response === 2) break;
      }
    }
    if (managed) { const result = await dialog.showMessageBox(window!, { message: 'Cancel the installation or verification and quit?', buttons: ['Keep working', 'Cancel and quit'], defaultId: 0, cancelId: 0 }); if (result.response === 0) return; const pending = managed; pending.controller.abort(); await pending.task.catch(() => {}); }
    if (service.queue.busy()) { const result = await dialog.showMessageBox(window!, { message: 'Cancel the remaining work and quit?', buttons: ['Keep working', 'Cancel work and quit'], defaultId: 0, cancelId: 0 }); if (result.response === 0) return; }
    await service.queue.stop(); await service.sessions.settled();
    quitting = true;
    if (backup) { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); const done = (message: any) => { if (message.flushed === 'quit') { clearTimeout(timer); backup?.off('message', done); resolve(); } }; backup!.on('message', done); backup!.postMessage({ flush: 'quit' }); }); await backup.terminate(); }
    records?.write('info', 'PicPatch closed normally.'); await records?.close();
    app.quit();
  } catch (error) { await dialog.showMessageBox(window!, { message: 'PicPatch could not finish closing.', detail: String(error) }); }
  finally { closing = false; }
}
async function pick(properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string) {
  const result = await dialog.showOpenDialog(window!, { title, properties }); return result.canceled ? [] : result.filePaths;
}
async function dispatch(action: string, payload: any, signal?: AbortSignal) {
  switch (action) {
    case 'records': return records?.list() ?? [];
    case 'ready': if (smoke) { if (qualification) { try { await qualifyInference(service, qualification, join(here, 'tools/uv')); } catch (error) { console.error(error); app.exit(1); return; } } clearTimeout(smokeTimer); await backup?.terminate(); await records?.close(); app.exit(0); } return;
    case 'paneState': if (payload.requestWidth !== undefined) { await savePaneState(paths.state, payload); return; } return readPaneState(paths.state);
    case 'layout': { const size = minimum(payload.sidebar === true); const [outerWidth, outerHeight] = window!.getSize(); const [contentWidth, contentHeight] = window!.getContentSize(); const height = Number.isFinite(payload.height) ? Math.max(size.height, payload.height) : size.height; window!.setMinimumSize(size.width + outerWidth - contentWidth, height + outerHeight - contentHeight); return; }
    case 'overview': return service.overview();
    case 'create': return service.sessions.create();
    case 'get': return service.sessions.get(payload.id);
    case 'draft': return service.draft(payload.id, payload.draft as Draft);
    case 'rename': if (typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('Enter a session name.'); return service.sessions.update(payload.id, session => { session.name = payload.name; });
    case 'delete': { const answer = await dialog.showMessageBox(window!, { message: 'Delete this session and its retained images?', detail: 'Exported images and original files are kept.', buttons: ['Keep session', 'Delete session'], cancelId: 0, defaultId: 0 }); if (answer.response === 1) await service.remove(payload.id); return; }
    case 'import': { const files = payload.path ? [payload.path] : await pick(['openFile', 'multiSelections'], 'Add images'); const assets = []; for (const path of files) assets.push(await service.importImage(payload.id, path)); return assets; }
    case 'mask': return service.mask(payload.id, payload.bytes);
    case 'submit': if (managed) throw new Error('Wait for the current resource operation.'); return service.queue.submit(payload.id, payload.draft, payload.samples, payload.parent);
    case 'cancel': return service.queue.cancel(payload.id, payload.runId);
    case 'resume': if (managed) throw new Error('Wait for the current resource operation.'); return service.queue.resume(payload.id);
    case 'export': { const result = await dialog.showSaveDialog(window!, { title: 'Save image', defaultPath: 'image.png', filters: [{ name: 'PNG image', extensions: ['png'] }] }); if (result.canceled || !result.filePath) return; return service.export(payload.id, payload.runId, result.filePath, payload.sidecar === true, payload.includeInputs === true); }
    case 'cancelManaged': managed?.controller.abort(); return;
    case 'preferences': if (managed) throw new Error('Wait for the current resource operation.'); await service.preferences(payload); return service.overview();
    case 'pickPath': return (await pick([payload.file ? 'openFile' : 'openDirectory'], 'Choose location'))[0];
    case 'pickComponent': {
      if (typeof payload.directory !== 'string' || !isAbsolute(payload.directory)) throw new Error('Choose the model bundle first.');
      const file = (await pick(['openFile'], 'Choose a file inside the model bundle'))[0]; if (!file) return;
      const path = relative(payload.directory, file); if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error('Choose a file inside the selected bundle.'); return path;
    }
    case 'verify': return service.verify(payload.modelId, signal);
    case 'removeManaged': {
      const answer = await dialog.showMessageBox(window!, { message: 'Remove this managed model revision?', detail: 'Other apps using this shared model may fail. Sessions and exported images are kept.', buttons: ['Keep model', 'Remove revision'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) return service.removeManaged(payload.modelId, payload.name, signal); return;
    }
    case 'models': return service.models();
    case 'prepare': { if (payload.download) { const model = (await service.overview()).models.find(m => m.id === payload.modelId); if (!model || model.acquisition !== 'pinned') throw new Error('No downloadable bundle for this selection.'); const answer = await dialog.showMessageBox(window!, { message: `Download ${model.id}?`, detail: `Approximately ${(model.downloadBytes / 1e9).toFixed(1)} GB. Stored in the selected shared model folder.`, buttons: ['Cancel', 'Download'], cancelId: 0, defaultId: 0 }); if (answer.response !== 1) return; return service.prepare(model.id, undefined, undefined, true, {}, signal); }
      const paths = payload.directory ? [payload.directory] : await pick(['openDirectory'], 'Select the model bundle'); if (!paths[0]) return; let checkpoint: string | undefined = payload.checkpoint;
      if (!checkpoint && (await service.overview()).models.find(m => m.id === payload.modelId)?.runtime.name === 'stable-diffusion.cpp') { const files = await pick(['openFile'], 'Select the checkpoint inside that bundle'); if (!files[0] || dirname(files[0]) !== paths[0]) throw new Error('Choose a checkpoint in the selected bundle.'); checkpoint = basename(files[0]); }
      return service.prepare(payload.modelId, paths[0], checkpoint, false, payload.components, signal); }
    case 'engines': return { mflux: await inspectEngine({ profile: service.settings.profile }), native: await inspectNativeEngine({ profile: service.settings.profile }) };
    case 'installNative': return installNativeEngine({ profile: service.settings.profile, signal });
    case 'installPython': { const uvExecutable = app.isPackaged ? join(here, 'tools/uv') : join(here, '../node_modules/.cache/picpatch-desktop/uv-0.13.1/uv-aarch64-apple-darwin/uv'); return installEngine({ profile: service.settings.profile, uvExecutable, toolDirectories: [...new Set([...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), '/opt/homebrew/bin', '/usr/local/bin'])], signal }); }
    case 'collection': { const paths = await pick(['openDirectory'], 'Open sessions collection'); if (paths[0]) await service.collection(paths[0]); return; }
    default: throw new Error('Unknown action.');
  }
}
