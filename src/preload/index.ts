import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { RendererRequest } from '../shared/messages.ts';
import type { Bridge } from '../shared/bridge.ts';
contextBridge.exposeInMainWorld('picpatch', {
  call: async (action: string, payload?: unknown) => { const reply = await ipcRenderer.invoke('picpatch:call', action, payload); if (!reply.ok) throw Object.assign(new Error(reply.message), { notice: reply.notice, code: reply.code, kind: reply.kind, effect: reply.effect }); return reply.value; },
  onCommand: (listener: (id: string) => void) => { const receive = (_event: unknown, id: string) => listener(id); ipcRenderer.on('picpatch:command', receive); return () => ipcRenderer.removeListener('picpatch:command', receive); },
  onQueue: (listener: (state: unknown) => void) => { const receive = (_event: unknown, state: unknown) => listener(state); ipcRenderer.on('picpatch:queue', receive); return () => ipcRenderer.removeListener('picpatch:queue', receive); },
  onChange: (listener: () => void) => { const receive = () => listener(); ipcRenderer.on('picpatch:changed', receive); return () => ipcRenderer.removeListener('picpatch:changed', receive); },
  onRequest: (listener: (request: RendererRequest) => Promise<unknown>) => { ipcRenderer.on('picpatch:request', (_event, id: number, request: RendererRequest) => { void listener(request).then(value => ipcRenderer.send('picpatch:reply', { id, ok: true, value }), error => ipcRenderer.send('picpatch:reply', { id, ok: false, message: String(error) })); }); },
  droppedFile: (file: File) => webUtils.getPathForFile(file),
} satisfies Bridge);
