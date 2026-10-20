import * as nodePath from 'node:path';
import type { BrowserWindow } from 'electron';

/** A request is trusted only from the main frame of `window` while it shows its own page. */
export function trustedSender(event: { sender: unknown; senderFrame: unknown }, window: BrowserWindow | undefined, page: string): boolean {
  return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && window.webContents.mainFrame.url === page;
}

/** The path of `file` relative to `directory`, with forward slashes, when the file is inside it; otherwise undefined. */
export function insideBundle(directory: string, file: string, paths: typeof nodePath = nodePath): string | undefined {
  const { isAbsolute, relative, sep } = paths;
  const path = relative(directory, file);
  // Bundle paths are stored with forward slashes on every platform.
  return path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path.split(sep).join('/');
}
