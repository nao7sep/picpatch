/** Only explicit commands focus an already visible workspace. Background notices
 * and quit bookkeeping must not reveal a hidden or minimized main window. */
const presentingCommands = new Set(['quit', 'settingsButton', 'about', 'shortcutsButton', 'new', 'import', 'save', 'saveSettings', 'run']);
export function focusWorkspaceForCommand(window: { isVisible(): boolean; isMinimized(): boolean; focus(): void }, id: string): void {
  if (presentingCommands.has(id) && window.isVisible() && !window.isMinimized()) window.focus();
}
