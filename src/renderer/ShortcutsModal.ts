import { t } from '../shared/i18n/index.ts';
import { shortcuts, shortcutText } from '../shared/shortcuts.ts';
import { modal } from './Modal.ts';
export function shortcutsModal() {
  const surface = document.getElementById('shortcuts') as HTMLDialogElement;
  const shell = modal(surface, document.getElementById('closeShortcuts') as HTMLButtonElement);
  document.getElementById('shortcutsButton')!.onclick = () => {
    const rows = surface.querySelector('dl')!; rows.replaceChildren();
    for (const entry of shortcuts) {
      const label = document.createElement('dt'); label.textContent = t(entry.label);
      const chord = document.createElement('dd'); const keys = document.createElement('kbd'); keys.textContent = shortcutText(entry, /Mac/.test(navigator.platform)); chord.append(keys);
      rows.append(label, chord);
    }
    const maskRows = surface.querySelector('#maskShortcuts')!; maskRows.replaceChildren();
    for (const [labelKey, chord] of [['ui.undo_stroke', 'Z'], ['ui.redo_stroke', 'Shift+Z']]) {
      const label = document.createElement('dt'); label.textContent = t(labelKey!);
      const value = document.createElement('dd'); const keys = document.createElement('kbd'); keys.textContent = `${/Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+${chord}`; value.append(keys); maskRows.append(label, value);
    }
    shell.open();
  };
}
