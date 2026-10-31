import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], load: undefined as Promise<void> | undefined }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    options: any; destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, setWindowOpenHandler: vi.fn(), send: vi.fn(), setZoomFactor: vi.fn(), getZoomFactor: () => 1, isDestroyed: () => false });
    constructor(options: any) { super(); this.options = options; mocks.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getSize() { return [1100,720]; } getContentSize() { return [1100,690]; } getBounds() { return { x: 0, y: 0, width: 1100, height: 720 }; }
    setMinimumSize = vi.fn(); setTitle = vi.fn(); setBackgroundColor = vi.fn(); show = vi.fn(); focus = vi.fn(); restore = vi.fn();
    async loadURL(url: string) { this.webContents.mainFrame.url = url; await mocks.load; }
    destroy() { this.destroyed = true; this.emit('closed'); } close() { this.destroy(); }
  }
  return { app: { isPackaged: false }, BrowserWindow: Window, ipcMain: { handle: (name: string, callback: any) => mocks.handlers.set(name, callback) }, screen: Object.assign(new EventEmitter(), { getDisplayMatching: () => ({ workAreaSize: { width: 1440, height: 900 } }) }) };
});
import { RecordsWindow } from '../../src/main/records-window.ts';
import { insideBundle, trustedSender } from '../../src/main/trust.ts';
import { win32 } from 'node:path';
import { locations } from '../../src/main/locations.ts';
import type { Records } from '../../src/main/core/records.ts';
beforeEach(() => { mocks.windows.length = 0; mocks.handlers.clear(); mocks.load = undefined; });
function setup() {
  const reader = { query: vi.fn().mockResolvedValue({ records: [], more: false }), detail: vi.fn().mockResolvedValue(null) };
  const failed = vi.fn();
  const owner = new RecordsWindow(reader as unknown as Records, () => ({ locale: { language:'en', format:'en' }, dark:false }), failed);
  return { owner, reader, failed };
}
it('creates one durable sandboxed window and refuses subframes, changed pages and main-workspace calls', async () => {
  const { owner, reader } = setup(); await owner.open(); await owner.open();
  expect(mocks.windows).toHaveLength(1); const window = mocks.windows[0];
  expect(window.options).toMatchObject({ name:'picpatch-records', windowStatePersistence: { bounds:true }, webPreferences: { sandbox:true, contextIsolation:true, nodeIntegration:false, preload: locations.preload('records') } });
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  expect(window.webContents.mainFrame.url).toBe(locations.page('records'));
  expect(trustedSender(event, window, locations.page('records'))).toBe(true);
  const handler = mocks.handlers.get('picpatch:records')!;
  await expect(handler({ ...event, senderFrame: {} }, 'query', {})).rejects.toThrow('Untrusted');
  expect((await handler(event, 'query', { current:true, level:'all', search:'' })).ok).toBe(true);
  expect(reader.query).toHaveBeenCalledTimes(1);
  expect((await handler(event, 'submit', {})).ok).toBe(false);
  expect((await handler(event, 'detail', '../path')).ok).toBe(false);
  window.webContents.mainFrame.url = 'https://example.com';
  await expect(handler(event, 'query', {})).rejects.toThrow('Untrusted');
  owner.close();
});
it('does not show a loading window after it was closed and does not duplicate an in-flight opening', async () => {
  let settle!: () => void; mocks.load = new Promise(resolve => { settle = resolve; });
  const { owner } = setup(); const opening = owner.open(); const second = owner.open();
  expect(mocks.windows).toHaveLength(1); const window = mocks.windows[0]; owner.close(); settle(); await opening; await second;
  expect(window.show).not.toHaveBeenCalled();
});
it('returns read failures and only sends bounded change notifications', async () => {
  vi.useFakeTimers();
  try {
    const { owner, reader, failed } = setup(); await owner.open(); const window = mocks.windows[0];
    reader.query.mockRejectedValueOnce(new Error('read failed'));
    const reply = await mocks.handlers.get('picpatch:records')!({ sender:window.webContents, senderFrame:window.webContents.mainFrame }, 'query', {current:false,level:'all',search:''});
    expect(reply.ok).toBe(false); expect(failed).toHaveBeenCalledTimes(1);
    for (let i=0;i<200;i++) owner.changed(); await vi.advanceTimersByTimeAsync(250);
    expect(window.webContents.send).toHaveBeenCalledTimes(1); owner.close();
  } finally { vi.useRealTimers(); }
});

import { focusWorkspaceForCommand } from '../../src/main/workspace-command.ts';
it('focuses the visible quit or settings owner over a secondary window without background reveals', () => {
  const window = { isVisible: () => true, isMinimized: () => false, focus: vi.fn() };
  for (const id of ['quit','settingsButton','about','shortcutsButton']) focusWorkspaceForCommand(window, id);
  expect(window.focus).toHaveBeenCalledTimes(4);
  for (const id of ['beginClose','endClose','shutdown']) focusWorkspaceForCommand(window, id);
  expect(window.focus).toHaveBeenCalledTimes(4);
  focusWorkspaceForCommand({ ...window, isVisible: () => false }, 'quit');
  focusWorkspaceForCommand({ ...window, isMinimized: () => true }, 'quit');
  expect(window.focus).toHaveBeenCalledTimes(4);
});
it('accepts bundle components only inside the chosen bundle', () => {
  expect(insideBundle('/models/bundle', '/models/bundle/vae/model.safetensors')).toBe('vae/model.safetensors');
  for (const outside of ['/models/bundle', '/models/other/model.gguf', '/models/bundle-two/model.gguf', '/elsewhere']) expect(insideBundle('/models/bundle', outside)).toBeUndefined();
});
it('stores Windows bundle paths with forward slashes and refuses other drives', () => {
  expect(insideBundle('C:\\models\\sd15', 'C:\\models\\sd15\\vae\\model.safetensors', win32)).toBe('vae/model.safetensors');
  expect(insideBundle('C:\\models\\sd15', 'D:\\other\\model.safetensors', win32)).toBeUndefined();
});
