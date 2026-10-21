import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pickPaths } from '../../src/main/native-pickers.ts';
import { insideBundle } from '../../src/main/trust.ts';

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog } }));
const owner = {} as BrowserWindow;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'picpatch-pickers-')); showOpenDialog.mockReset(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('opens at literal existing folders and files, returns literal results and preserves cancellation', async () => {
  const folder = join(root, 'bundle $HOME '); await mkdir(folder);
  const file = join(folder, 'weights.bin '); await writeFile(file, 'weights');
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
  await expect(pickPaths(owner, ['openFile'], 'Component', folder)).resolves.toEqual([file]);
  expect(showOpenDialog).toHaveBeenLastCalledWith(owner, { title: 'Component', properties: ['openFile'], defaultPath: folder });
  expect(insideBundle(folder, file)).toBe('weights.bin ');
  expect(insideBundle(folder, join(root, 'outside.bin'))).toBeUndefined();
  await pickPaths(owner, ['openFile'], 'Executable', file);
  expect(showOpenDialog.mock.calls.at(-1)?.[1].defaultPath).toBe(file);
  showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [file] });
  await expect(pickPaths(owner, ['openDirectory'], 'Collection', folder)).resolves.toEqual([]);
  expect(await readFile(file, 'utf8')).toBe('weights');
});

it('uses an existing ancestor for missing locations and leaves generic pickers to the platform', async () => {
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
  const missing = join(root, 'missing', 'models');
  await pickPaths(owner, ['openDirectory'], 'Models', missing);
  expect(showOpenDialog.mock.calls.at(-1)?.[1].defaultPath).toBe(root);
  for (const value of [undefined, '', 'relative']) {
    await pickPaths(owner, ['openFile', 'multiSelections'], 'Images', value);
    expect(showOpenDialog.mock.calls.at(-1)?.[1]).not.toHaveProperty('defaultPath');
  }
});
