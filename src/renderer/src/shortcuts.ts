import { shortcutCommand } from '../../shared/shortcuts.ts';
import { isComposing } from './ime.ts';
export function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('textarea,[contenteditable=true],input:not([type=range]):not([type=checkbox]):not([type=radio])');
}
export function controlBelongsToText(event: KeyboardEvent): boolean {
  return /Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey && editableTarget(event.target);
}
export function commandShortcuts(dispatch: (id: string) => void) {
  const handle = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isComposing(event)) return;
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (controlBelongsToText(event)) return;
    if (!event.ctrlKey && !event.metaKey && (editableTarget(event.target) || target?.closest('select,[role=listbox]'))) return;
    const id = shortcutCommand(event); if (!id) return;
    event.preventDefault();
    if (!event.repeat) dispatch(id);
  };
  document.addEventListener('keydown', handle);
  return () => document.removeEventListener('keydown', handle);
}
