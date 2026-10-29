// Where the built app's parts live. electron-vite emits main with its module layout
// kept (out/main/src/main/), preloads to out/preload and pages to out/renderer;
// packaging adds tools and icons under the app's resources.
import { app } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const out = fileURLToPath(new URL('../../../', import.meta.url));
/** Set by electron-vite only in development: the dev server's origin. */
export const devServer = process.env.ELECTRON_RENDERER_URL;

const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv';
export const locations = {
  /** A renderer page's address; the exact value main trusts as its sender. */
  page: (name: 'index' | 'records') => devServer ? `${devServer}/${name}.html` : pathToFileURL(join(out, 'renderer', `${name}.html`)).href,
  preload: (name: 'index' | 'records') => join(out, 'preload', `${name}.cjs`),
  worker: (name: 'backup-worker' | 'records-worker') => join(out, 'main', `${name}.js`),
  /** The window icon Windows and Linux paint; macOS takes the bundle's. */
  icon: () => app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(out, '..', 'build', 'icon.png'),
  uv: () => app.isPackaged ? join(process.resourcesPath, 'tools', uvName) : join(out, '..', 'node_modules', '.cache', 'picpatch-desktop', 'uv', uvName),
};
