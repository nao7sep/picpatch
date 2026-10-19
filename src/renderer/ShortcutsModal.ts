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
      const chord = document.createElement('dd'); chord.textContent = shortcutText(entry, /Mac/.test(navigator.platform));
      rows.append(label, chord);
    }
    shell.open();
  };
}
