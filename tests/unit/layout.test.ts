import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readPaneState, savePaneState } from '../../src/app/layout-state.ts';
it('keeps pane intent independently of layout clamps and ignores corrupt disposable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-layout-')); const path = join(directory, 'state.json');
  try {
    expect(await readPaneState(path)).toEqual({ requestWidth: 300, sidebar: false });
    await savePaneState(path, { requestWidth: 500, sidebar: true });
    expect(await readPaneState(path)).toEqual({ requestWidth: 500, sidebar: true });
    await expect(savePaneState(path, { requestWidth: 0, sidebar: true })).rejects.toThrow('Invalid');
    expect(JSON.parse(await readFile(path, 'utf8')).requestWidth).toBe(500);
    await writeFile(path, 'bad'); expect(await readPaneState(path)).toEqual({ requestWidth: 300, sidebar: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
