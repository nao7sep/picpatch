import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Bridge } from '../shared/bridge.ts';
contextBridge.exposeInMainWorld('picpatch', {
  call: async (action: string, payload?: unknown) => { const reply = await ipcRenderer.invoke('picpatch:call', action, payload); if (!reply.ok) throw Object.assign(new Error(reply.message), { notice: reply.notice }); return reply.value; },
  onCommand: (listener: (id: string) => void) => { const receive = (_event: unknown, id: string) => listener(id); ipcRenderer.on('picpatch:command', receive); return () => ipcRenderer.removeListener('picpatch:command', receive); },
  onChange: (listener: () => void) => { const receive = () => listener(); ipcRenderer.on('picpatch:changed', receive); return () => ipcRenderer.removeListener('picpatch:changed', receive); },
  onFlush: (listener: () => Promise<void>) => { ipcRenderer.on('picpatch:flush', () => { void listener().then(() => ipcRenderer.send('picpatch:flushed', { ok: true }), error => ipcRenderer.send('picpatch:flushed', { ok: false, message: String(error) })); }); },
  droppedFile: (file: File) => webUtils.getPathForFile(file),
} satisfies Bridge);
