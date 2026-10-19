import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readPaneState, savePaneState } from '../../src/app/layout-state.ts';
import { layout, minimum, railWidth } from '../../src/shared/layout.ts';
it('keeps pane intent independently of layout clamps and ignores corrupt disposable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-layout-')); const path = join(directory, 'state.json');
  try {
    expect(await readPaneState(path)).toEqual({ railWidth: layout.railDefault, optionsPane: false });
    await savePaneState(path, { railWidth: 320, optionsPane: true });
    expect(await readPaneState(path)).toEqual({ railWidth: 320, optionsPane: true });
    await expect(savePaneState(path, { railWidth: 0, optionsPane: true })).rejects.toThrow('Invalid');
    expect(JSON.parse(await readFile(path, 'utf8')).railWidth).toBe(320);
    await writeFile(path, 'bad'); expect(await readPaneState(path)).toEqual({ railWidth: layout.railDefault, optionsPane: false });
    // The earlier request-pane layout is disposable and falls back field by field.
    await writeFile(path, JSON.stringify({ requestWidth: 500, sidebar: true, exportDirectory: directory }));
    expect(await readPaneState(path)).toEqual({ railWidth: layout.railDefault, optionsPane: false, exportDirectory: directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('retains valid UI zoom beside pane state and drops an invalid zoom independently', async () => {
  const directory = await mkdtemp(join(tmpdir(),'picpatch-zoom-')); const path = join(directory,'state.json');
  try {
    await savePaneState(path,{railWidth:300,optionsPane:true,uiZoom:1.44});
    expect(await readPaneState(path)).toEqual({railWidth:300,optionsPane:true,uiZoom:1.44});
    await writeFile(path,JSON.stringify({railWidth:300,optionsPane:true,uiZoom:'bad'}));
    expect(await readPaneState(path)).toEqual({railWidth:300,optionsPane:true});
  } finally { await rm(directory,{recursive:true,force:true}); }
});
it('derives the window floor from the panes and narrows the rail only to keep the stage whole', () => {
  expect(minimum(true).width - minimum(false).width).toBe(layout.options);
  expect(railWidth(400, 2000, false)).toBe(400);
  expect(railWidth(400, layout.rail + layout.splitter + layout.stage + 50, false)).toBe(layout.rail + 50);
  expect(railWidth(400, 100, true)).toBe(layout.rail);
  expect(railWidth(undefined, 2000, false)).toBe(layout.railDefault);
});
