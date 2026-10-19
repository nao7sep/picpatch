import { UiError } from '../shared/i18n/index.ts';
/** Finder/Explorer files replace the source via the same import command as the picker.
 * One source per drop; reject a mixed/multiple offer before importing anything.
 * Repeated inputs remain independent session assets, as they do through Add source image.
 */
export function sourceDrop(receiver: HTMLElement, importFile: (file: File) => Promise<unknown>, report: (error: unknown) => void) {
  const files = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const clear = () => receiver.classList.remove('dropTarget');
  const blocked = () => receiver.closest('[inert],[hidden]') || document.querySelector('dialog[open]');
  receiver.addEventListener('dragover', event => { if (!files(event) || blocked()) { clear(); return; } event.preventDefault(); receiver.classList.add('dropTarget'); });
  receiver.addEventListener('dragleave', event => { if (!(event.relatedTarget instanceof Node) || !receiver.contains(event.relatedTarget)) clear(); });
  receiver.addEventListener('drop', event => {
    clear(); if (!files(event) || blocked()) return;
    event.preventDefault(); event.stopPropagation();
    const offered = Array.from(event.dataTransfer?.files ?? []);
    if (offered.length !== 1) { report(new UiError('ui.drop_one_source')); return; }
    void importFile(offered[0]!).catch(report);
  });
  document.addEventListener('dragend', clear); window.addEventListener('blur', clear);
  // Refuse navigation outside the source receiver. Ordinary text drops into fields stay native.
  for (const name of ['dragover', 'drop'] as const) document.addEventListener(name, event => {
    if (files(event) || (!(event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest('input,textarea'))) && event.dataTransfer?.types.includes('text/uri-list'))) event.preventDefault();
    if (name === 'drop') clear();
  });
}
