import { logsView } from './logs.ts';
const dispose = logsView(window.picpatchLogs);
window.addEventListener('pagehide', dispose, { once: true });
