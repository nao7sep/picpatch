import { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net, powerMonitor } from 'electron';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { installEngine, installNativeEngine, inspectEngine, inspectNativeEngine } from 'picpatchsdk';
import { appPaths } from '../app/paths.ts';
import { Application } from '../app/service.ts';
import { minimum } from '../shared/layout.ts';
import type { Draft } from '../app/types.ts';
const here = dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([{ scheme: 'picpatch-image', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window: BrowserWindow | undefined; let service: Application; let quitting = false; let closing = false;
let backup: Worker | undefined;
const paths = await appPaths();
app.setPath('userData', paths.root); app.setPath('sessionData', join(paths.root, 'browser'));
await mkdir(join(paths.root, 'browser'), { recursive: true, mode: 0o700 });
const smoke = process.argv.includes('--smoke');
let smokeTimer: ReturnType<typeof setTimeout> | undefined;
let flushReply: ((reply: { ok: boolean; message?: string }) => void) | undefined;
ipcMain.on('picpatch:flushed', (event, reply) => { if (event.sender === window?.webContents) flushReply?.(reply); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { window?.show(); });
  void app.whenReady().then(start).catch(async error => { await dialog.showMessageBox({ type: 'error', message: 'PicPatch could not start.', detail: String(error) }); app.exit(1); });
}
async function start() {
  backup = new Worker(join(here, 'backup-worker.mjs'));
  backup.on('error', () => { if (service) service.historyIssue = 'Backup history is unavailable; primary session saves remain active.'; });
  backup.on('message', message => { if (message.issue && service) { service.historyIssue = 'Backup history could not capture some work. Primary session saves remain active.'; window?.webContents.send('picpatch:changed'); } });
  service = await Application.open(paths, () => window?.webContents.send('picpatch:changed'), (path, bytes, sha256) => backup?.postMessage({ database: paths.backups, path, bytes, sha256 }));
  protocol.handle('picpatch-image', async request => {
    try { const url = new URL(request.url); const path = await service.sessions.imagePath(url.hostname, url.pathname.slice(1)); const response = await net.fetch(pathToFileURL(path).href); const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*'); return new Response(response.body, { status: response.status, headers }); }
    catch { return new Response('Image unavailable', { status: 404 }); }
  });
  const renderer = pathToFileURL(join(here, 'index.html')).href;
  ipcMain.handle('picpatch:call', async (event, action: string, payload: any = {}) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== renderer) throw new Error('Untrusted request.');
    try { return { ok: true, value: await dispatch(action, payload) }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The operation could not finish.' }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PicPatch', submenu: [{ label: 'About PicPatch', click: () => { void dialog.showMessageBox(window!, { message: 'PicPatch', detail: 'Generate and refine images with local AI.' }); } }, { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: minimum(false).width, minHeight: minimum(false).height, title: 'PicPatch', show: false, backgroundColor: '#17191c', webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== renderer) event.preventDefault(); });
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' picpatch-image: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"] } }));
  window.once('ready-to-show', () => { if (!smoke) window?.show(); });
  if (smoke) smokeTimer = setTimeout(() => { app.exit(1); }, 15000);
  window.on('close', event => { if (!quitting) { event.preventDefault(); void close(); } });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void close(); } });
  powerMonitor.on('shutdown', () => { quitting = true; service.queue.stop().catch(() => {}); app.exit(0); });
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
    if (service.queue.busy()) { const result = await dialog.showMessageBox(window!, { message: 'Cancel the remaining work and quit?', buttons: ['Keep working', 'Cancel work and quit'], defaultId: 0, cancelId: 0 }); if (result.response === 0) return; }
    await service.queue.stop(); await service.sessions.settled();
    quitting = true;
    if (backup) { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); const done = (message: any) => { if (message.flushed === 'quit') { clearTimeout(timer); backup?.off('message', done); resolve(); } }; backup!.on('message', done); backup!.postMessage({ flush: 'quit' }); }); await backup.terminate(); }
    app.quit();
  } catch (error) { await dialog.showMessageBox(window!, { message: 'PicPatch could not finish closing.', detail: String(error) }); }
  finally { closing = false; }
}
async function pick(properties: ('openFile' | 'openDirectory' | 'multiSelections')[], title: string) {
  const result = await dialog.showOpenDialog(window!, { title, properties }); return result.canceled ? [] : result.filePaths;
}
async function dispatch(action: string, payload: any) {
  switch (action) {
    case 'ready': if (smoke) { clearTimeout(smokeTimer); await backup?.terminate(); app.exit(0); } return;
    case 'layout': { const size = minimum(payload.sidebar === true); window!.setMinimumSize(size.width, size.height); return; }
    case 'overview': return service.overview();
    case 'create': return service.sessions.create();
    case 'get': return service.sessions.get(payload.id);
    case 'draft': return service.draft(payload.id, payload.draft as Draft);
    case 'rename': if (typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('Enter a session name.'); return service.sessions.update(payload.id, session => { session.name = payload.name; });
    case 'delete': { const answer = await dialog.showMessageBox(window!, { message: 'Delete this session and its retained images?', detail: 'Exported images and original files are kept.', buttons: ['Keep session', 'Delete session'], cancelId: 0, defaultId: 0 }); if (answer.response === 1) await service.remove(payload.id); return; }
    case 'import': { const files = payload.path ? [payload.path] : await pick(['openFile', 'multiSelections'], 'Add images'); const assets = []; for (const path of files) assets.push(await service.importImage(payload.id, path)); return assets; }
    case 'mask': return service.mask(payload.id, payload.bytes);
    case 'submit': return service.queue.submit(payload.id, payload.draft, payload.samples, payload.parent);
    case 'cancel': return service.queue.cancel(payload.id, payload.runId);
    case 'resume': return service.queue.resume(payload.id);
    case 'export': { const result = await dialog.showSaveDialog(window!, { title: 'Save image', defaultPath: 'image.png', filters: [{ name: 'PNG image', extensions: ['png'] }] }); if (result.canceled || !result.filePath) return; return service.export(payload.id, payload.runId, result.filePath, payload.sidecar === true, payload.includeInputs === true); }
    case 'models': return service.models();
    case 'prepare': { if (payload.download) { const model = (await service.overview()).models.find(m => m.id === payload.modelId); if (!model || model.acquisition !== 'pinned') throw new Error('No downloadable bundle for this selection.'); const answer = await dialog.showMessageBox(window!, { message: `Download ${model.id}?`, detail: `Approximately ${(model.downloadBytes / 1e9).toFixed(1)} GB. Stored in the selected shared model folder.`, buttons: ['Cancel', 'Download'], cancelId: 0, defaultId: 0 }); if (answer.response !== 1) return; return service.prepare(model.id, undefined, undefined, true); }
      const paths = await pick(['openDirectory'], 'Select the model bundle'); if (!paths[0]) return; let checkpoint: string | undefined;
      if ((await service.overview()).models.find(m => m.id === payload.modelId)?.runtime.name === 'stable-diffusion.cpp') { const files = await pick(['openFile'], 'Select the checkpoint inside that bundle'); if (!files[0] || dirname(files[0]) !== paths[0]) throw new Error('Choose a checkpoint in the selected bundle.'); checkpoint = basename(files[0]); }
      return service.prepare(payload.modelId, paths[0], checkpoint); }
    case 'engines': return { mflux: await inspectEngine({ profile: service.settings.profile }), native: await inspectNativeEngine({ profile: service.settings.profile }) };
    case 'installNative': return installNativeEngine({ profile: service.settings.profile });
    case 'installPython': { const files = await pick(['openFile'], 'Select uv to install the Python engine'); if (!files[0]) return; return installEngine({ profile: service.settings.profile, uvExecutable: files[0] }); }
    case 'collection': { const paths = await pick(['openDirectory'], 'Open sessions collection'); if (paths[0]) await service.collection(paths[0]); return; }
    default: throw new Error('Unknown action.');
  }
}
