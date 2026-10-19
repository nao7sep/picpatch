import { contextBridge, ipcRenderer } from 'electron';
import type { LogsBridge } from '../shared/logs-bridge.ts';
const call = async (action: string, payload?: unknown) => {
  const reply = await ipcRenderer.invoke('picpatch:logs', action, payload);
  if (!reply.ok) throw new Error(reply.message);
  return reply.value;
};
function subscribe(channel: string, listener: () => void) { const receive = () => listener(); ipcRenderer.on(channel, receive); return () => ipcRenderer.removeListener(channel, receive); }
contextBridge.exposeInMainWorld('picpatchLogs', {
  resizeList: width => call('resizeList', width),
  query: query => call('query', query), detail: id => call('detail', id), appearance: () => call('appearance'), close: () => call('close'),
  onRecordsChanged: listener => subscribe('picpatch:logsChanged', listener),
  onAppearanceChanged: listener => subscribe('picpatch:logsAppearance', listener),
} satisfies LogsBridge);
