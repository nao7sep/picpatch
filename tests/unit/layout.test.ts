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
it('retains valid UI zoom beside pane state and drops an invalid zoom independently', async () => {
  const directory = await mkdtemp(join(tmpdir(),'picpatch-zoom-')); const path = join(directory,'state.json');
  try {
    await savePaneState(path,{requestWidth:420,sidebar:true,uiZoom:1.44});
    expect(await readPaneState(path)).toEqual({requestWidth:420,sidebar:true,uiZoom:1.44});
    await writeFile(path,JSON.stringify({requestWidth:420,sidebar:true,uiZoom:'bad'}));
    expect(await readPaneState(path)).toEqual({requestWidth:420,sidebar:true});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
it('opens sessions on first use when several exist, preserving an explicit hidden choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'picpatch-layout-first-'));
  try {
    const path = join(root, 'layout.json');
    expect((await readPaneState(path, true)).sidebar).toBe(true);
    await savePaneState(path, { requestWidth: 300, sidebar: false, exportDirectory: root, recordsListWidth: 410 });
    expect(await readPaneState(path, true)).toMatchObject({ sidebar: false, exportDirectory: root, recordsListWidth: 410 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
