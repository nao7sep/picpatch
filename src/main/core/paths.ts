import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';

export interface AppPaths { root: string; sessions: string; config: string; state: string; backups: string }
/** App-only ambient resolution. The SDK continues to receive absolute arguments. */
export function resolveAppPaths(): AppPaths {
  const home = homedir();
  const value = process.env.PICPATCH_DATA_DIR;
  let selected = value?.trim() ? value : join(home, '.picpatch');
  selected = selected.replace(/^~(?=[/\\]|$)/, home).replace(/\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g, (_all, unix, win) => {
    const name = unix ?? win; const replacement = process.env[name];
    if (replacement === undefined) throw new Error(`Unresolved storage variable: ${name}`);
    return replacement;
  });
  const root = isAbsolute(selected) ? selected : resolve(home, selected);
  return { root, sessions: join(root, 'sessions'), config: join(root, 'config.json'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') };
}

export async function appPaths(): Promise<AppPaths> {
  const paths = resolveAppPaths();
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(paths.root, 0o700);
  return paths;
}
