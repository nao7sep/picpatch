// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { shortcuts, shortcutCommand, shortcutText, accelerator } from '../../src/shared/shortcuts.ts';
import { commandShortcuts } from '../../src/renderer/shortcuts.ts';
import { catalogues } from '../../src/shared/i18n/index.ts';
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
it('advertises the bound commands with platform words and accepts both command modifiers', async () => {
  const en = await catalogues.en();
  for (const entry of shortcuts) {
    expect(en).toHaveProperty(entry.label);
    expect(shortcutText(entry,true)).toMatch(/^Cmd\+/); expect(shortcutText(entry,false)).toMatch(/^Ctrl\+/);
    expect(accelerator(entry.id)).toMatch(/^CmdOrCtrl\+/);
    for (const modifier of ['metaKey','ctrlKey']) {
      const event = { key: entry.key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: 'shift' in entry, [modifier]: true };
      expect(shortcutCommand(event)).toBe(entry.id); expect(shortcutCommand({ ...event, altKey: true })).toBeUndefined();
    }
  }
});
it('accepts shifted slash layouts and Question without inventing Shift variants for other commands', () => {
  const event = { key:'/', metaKey:true, ctrlKey:false, altKey:false, shiftKey:true };
  expect(shortcutCommand(event)).toBe('shortcutsButton'); expect(shortcutCommand({...event,key:'?'})).toBe('shortcutsButton');
  expect(shortcutCommand({...event,key:'?',metaKey:false})).toBe('shortcutsButton'); expect(shortcutCommand({...event,key:'w'})).toBeUndefined();
});
it('protects macOS Ctrl text editing, native typeahead, AltGr and IME while allowing Cmd', () => {
  vi.spyOn(navigator,'platform','get').mockReturnValue('MacIntel');
  document.body.innerHTML = '<textarea></textarea><select><option>A</option></select><button></button>';
  const dispatch = vi.fn(); commandShortcuts(dispatch);
  const press = (target: Element, key: string, options: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));
  const text = document.querySelector('textarea')!; const button = document.querySelector('button')!;
  expect(press(text,'n',{ctrlKey:true})).toBe(true); expect(press(text,'?',{shiftKey:true})).toBe(true);
  expect(press(document.querySelector('select')!,'?',{shiftKey:true})).toBe(true);
  expect(press(button,'n',{ctrlKey:true,altKey:true})).toBe(true); expect(press(button,'n',{metaKey:true,isComposing:true})).toBe(true);
  expect(dispatch).not.toHaveBeenCalled(); press(text,'n',{metaKey:true}); expect(dispatch).toHaveBeenLastCalledWith('new');
  press(button,'n',{ctrlKey:true}); expect(dispatch).toHaveBeenCalledTimes(2);
});
