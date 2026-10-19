/** App-owned commands; native text-editing and window roles keep their OS bindings. */
export const shortcuts = [
  { id: 'new', label: 'ui.new_session_2', key: 'n', name: 'N' },
  { id: 'import', label: 'ui.open_source_image', key: 'o', name: 'O' },
  { id: 'save', label: 'ui.save_image_2', key: 's', name: 'S' },
  { id: 'saveSettings', label: 'ui.save_image_with_settings', key: 's', name: 'S', shift: true },
  { id: 'run', label: 'ui.generate_or_edit', key: 'enter', name: 'Enter' },
  { id: 'settingsButton', label: 'ui.settings', key: ',', name: 'Comma' },
  { id: 'shortcutsButton', label: 'shortcuts.title', key: '/', name: 'Slash' },
  { id: 'closeWindow', label: 'native.close', key: 'w', name: 'W' },
  { id: 'quit', label: 'native.quit', key: 'q', name: 'Q' },
] as const;
export type ShortcutId = typeof shortcuts[number]['id'];
export function accelerator(id: ShortcutId): string {
  const entry = shortcuts.find(entry => entry.id === id)!;
  return `CmdOrCtrl+${'shift' in entry ? 'Shift+' : ''}${entry.key === ',' ? ',' : entry.key === '/' ? '/' : entry.name}`;
}
export function shortcutText(entry: typeof shortcuts[number], mac: boolean): string {
  return `${mac ? 'Cmd' : 'Ctrl'}+${'shift' in entry ? 'Shift+' : ''}${entry.name}${entry.id === 'shortcutsButton' ? ' / Question' : ''}`;
}
export function shortcutCommand(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): ShortcutId | undefined {
  if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) return 'shortcutsButton';
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === '/' || key === '?') return 'shortcutsButton';
  return shortcuts.find(entry => entry.key === key && ('shift' in entry) === event.shiftKey)?.id;
}
