import { BrowserWindow } from 'electron';
import { t, errorText } from '../shared/i18n/index.ts';
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** No workspace authority, preload or script is needed for this last-resort surface. */
export function startupFailureHtml(error: unknown, dark: boolean) {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://picpatch.invalid"><title>PicPatch</title><style>
  :root{color-scheme:${dark ? 'dark' : 'light'}}body{font:13px system-ui;margin:0;padding:24px;background:light-dark(#f4f4f2,#17191c);color:light-dark(#202124,#f2f2f2)}h1{font-size:18px}p{line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;user-select:text}nav{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}button{font:inherit;color:inherit;cursor:pointer;background:light-dark(#fff,#292c31);border:1px solid light-dark(#ccc,#555);border-radius:6px;padding:7px 16px;text-decoration:none}button:focus-visible{outline:2px solid light-dark(#0864cd,#84b8ff)}summary{cursor:pointer}
  </style></head><body><h1>${escape(t('startup.title'))}</h1><p>${escape(t('startup.detail'))}</p><p role="alert">${escape(errorText(error))}</p><details><summary>${escape(t('startup.details'))}</summary><pre>${escape(details)}</pre></details><nav><form action="https://picpatch.invalid/quit"><button type="submit">${escape(t('native.quit'))}</button></form><form action="https://picpatch.invalid/retry"><button type="submit">${escape(t('startup.retry'))}</button></form></nav></body></html>`;
}
export async function startupFailureWindow(error: unknown, dark: boolean, retry: () => void, quit: () => void) {
  const window = new BrowserWindow({ title: 'PicPatch', width: 620, height: 440, minWidth: 400, minHeight: 300, show: false, backgroundColor: dark ? '#17191c' : '#f4f4f2', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.setMenu(null); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let acted = false;
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault(); if (acted) return;
    const action = url.replace(/\?$/, '');
    if (action === 'https://picpatch.invalid/retry') { acted = true; retry(); }
    else if (action === 'https://picpatch.invalid/quit') { acted = true; quit(); }
  });
  window.on('closed', () => { if (!acted) quit(); });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupFailureHtml(error, dark))}`);
  window.show(); return window;
}
