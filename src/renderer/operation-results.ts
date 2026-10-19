import { errorText, t } from '../shared/i18n/index.ts';
/** Persistent results belong to this surface; repeated state refreshes do not announce them again. */
export function operationResults(host: HTMLElement) {
  const entries = new Map<string, { error: unknown; text: string; row?: HTMLElement; label?: () => string }>();
  function show(key: string, error: unknown, label?: () => string) {
    const text = label ? t('common.lines', { first: label(), rest: errorText(error) }) : errorText(error), previous = entries.get(key);
    if (previous?.text === text) return;
    previous?.row?.remove();
    const row = document.createElement('div'); row.className = 'operationResult'; row.setAttribute('role', 'alert');
    const copy = document.createElement('span'); copy.textContent = text;
    const close = document.createElement('button'); close.className = 'quietClose'; close.setAttribute('aria-label', t('ui.clear_message'));
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    close.onclick = () => { row.remove(); entries.set(key, { error, text, label }); host.hidden = !host.childElementCount; };
    row.append(copy, close); host.append(row); host.hidden = false; entries.set(key, { error, text, row, label });
  }
  function clear(key: string) { entries.get(key)?.row?.remove(); entries.delete(key); host.hidden = !host.childElementCount; }
  function localize() { for (const entry of entries.values()) if (entry.row) { entry.text = entry.label ? t('common.lines', { first: entry.label(), rest: errorText(entry.error) }) : errorText(entry.error); entry.row.querySelector('span')!.textContent = entry.text; entry.row.querySelector('button')!.setAttribute('aria-label', t('ui.clear_message')); } }
  return { show, clear, localize };
}
