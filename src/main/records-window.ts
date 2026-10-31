import { BrowserWindow, ipcMain, screen } from 'electron';
import { locations } from './locations.ts';
import { recordsQuery, recordId } from '../shared/records.ts';
import type { RecordsAppearance } from '../shared/records-bridge.ts';
import type { Records } from './core/records.ts';
import { normalizeZoom, windowBackground, windowMinimum } from '../shared/appearance.ts';
import { t } from '../shared/i18n/index.ts';
import { trustedSender } from './trust.ts';
/** The Records renderer has no workspace, file-picker, or model-management authority. */
export class RecordsWindow {
  private window?: BrowserWindow;
  private opening?: Promise<BrowserWindow>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private renderer: string;
  private fitMinimum?: () => void;
  constructor(reader: Pick<Records, 'query' | 'detail'>, private appearance: () => RecordsAppearance, private failed: (error: unknown) => void, private resizeList: (width: number) => Promise<void> = async () => {}) {
    this.renderer = locations.page('records');
    ipcMain.handle('picpatch:records', async (event, action: string, payload: unknown) => {
      if (!trustedSender(event, this.window, this.renderer)) throw new Error('Untrusted records request.');
      try {
        switch (action) {
          case 'query': return { ok: true, value: await reader.query(recordsQuery(payload)) };
          case 'detail': return { ok: true, value: await reader.detail(recordId(payload)) };
          case 'appearance': return { ok: true, value: this.appearance() };
          case 'resizeList': if (typeof payload !== 'number' || !Number.isFinite(payload) || payload < 320 || payload > 10000) throw new Error('Invalid records pane width.'); await this.resizeList(payload); return { ok: true };
          case 'close': this.window?.close(); return { ok: true };
          default: throw new Error('Unknown records action.');
        }
      } catch (error) {
        // The UI retries only by explicit action, so recording this cannot cause a read loop.
        this.failed(error); return { ok: false, message: t('records.failed') };
      }
    });
  }
  changed() {
    if (this.notifyTimer || !this.window || this.window.isDestroyed()) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; this.send('picpatch:recordsChanged'); }, 250);
  }
  private send(channel: string) { if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) this.window.webContents.send(channel); }
  updateAppearance() {
    if (this.window && !this.window.isDestroyed()) { this.window.setTitle(t('ui.records')); this.window.webContents.setZoomFactor(normalizeZoom(this.appearance().uiZoom)); this.fitMinimum?.(); this.window.setBackgroundColor(windowBackground(this.appearance().dark)); }
    this.send('picpatch:recordsAppearance');
  }
  async open(visible = true): Promise<BrowserWindow> {
    if (this.opening) return this.opening;
    if (this.window && !this.window.isDestroyed()) { if (this.window.isMinimized()) this.window.restore(); if (visible) { this.window.show(); this.window.focus(); } return this.window; }
    const window = this.window = new BrowserWindow({ name: 'picpatch-records', windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' }, title: t('ui.records'), ...(process.platform === 'darwin' ? {} : { icon: locations.icon() }), width: 1100, height: 720, minWidth: 765, minHeight: 480, show: false, backgroundColor: windowBackground(this.appearance().dark), webPreferences: { zoomFactor: normalizeZoom(this.appearance().uiZoom), preload: locations.preload('records'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    const minimum = () => {
      if (window.isDestroyed()) return;
      const [width, height] = window.getSize(); const [cw, ch] = window.getContentSize();
      // List 320 + divider 5 + detail 440; controls 200 + list/detail 240 + footer 40.
      const floor = windowMinimum({ width: 765, height: 480 }, window.webContents.getZoomFactor(), { width: width - cw, height: height - ch }, screen.getDisplayMatching(window.getBounds()).workAreaSize);
      window.setMinimumSize(floor.width, floor.height);
    };
    this.fitMinimum = minimum;
    window.on('move', minimum); screen.on('display-metrics-changed', minimum); minimum();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== this.renderer) event.preventDefault(); });
    window.on('closed', () => { screen.off('display-metrics-changed', minimum); if (this.window === window) this.window = undefined; });
    const open = window.loadURL(this.renderer).then(() => { if (!window.isDestroyed() && visible) { window.show(); window.focus(); } return window; }, error => { if (!window.isDestroyed()) window.destroy(); throw error; });
    this.opening = open;
    try { return await open; } finally { if (this.opening === open) this.opening = undefined; }
  }
  close() { clearTimeout(this.notifyTimer); this.notifyTimer = undefined; this.window?.destroy(); this.window = undefined; }
}
