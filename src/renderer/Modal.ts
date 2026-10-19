import { t } from '../shared/i18n/index.ts';
import { controlBelongsToText } from './shortcuts.ts';
import { shortcutCommand } from '../shared/shortcuts.ts';
import { isComposing } from './ime.ts';
const closers = new WeakMap<HTMLDialogElement, () => Promise<void>>();
export function closeTopModal(): boolean { const surface = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1); if (!surface) return false; void closers.get(surface)?.(); return true; }
/** Native dialog owns focus containment; this shell owns guarded close and focus return. */
export function modal(surface: HTMLDialogElement, dismiss: HTMLButtonElement, options: { canClose?: () => boolean | Promise<boolean>; focus?: () => HTMLElement } = {}) {
  let trigger: HTMLElement | undefined;
  let closing = false;
  async function requestClose() {
    if (closing || !surface.open || isComposing()) return;
    closing = true;
    try { if (!options.canClose || await options.canClose()) surface.close(); }
    finally { closing = false; }
  }
  const close = document.createElement('button'); close.type = 'button'; close.className = 'quietClose modalClose';
  close.dataset.i18nAriaLabel = 'ui.close'; close.setAttribute('aria-label', t('ui.close'));
  close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  close.onclick = () => { void requestClose(); };
  const header = surface.querySelector('.modalHeader');
  if (header) header.append(close); else surface.prepend(close);
  closers.set(surface, requestClose);
  surface.addEventListener('cancel', event => { event.preventDefault(); void requestClose(); });
  dismiss.onclick = () => { void requestClose(); };
  surface.addEventListener('close', () => { if (trigger?.isConnected) trigger.focus(); });
  surface.addEventListener('keydown', event => {
    if (isComposing(event)) return;
    if (controlBelongsToText(event)) return;
    if (shortcutCommand(event) === 'closeWindow') { event.preventDefault(); event.stopPropagation(); void requestClose(); }
  });
  return {
    open() { trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; surface.showModal(); (options.focus?.() ?? dismiss).focus(); },
    close() { surface.close(); },
    requestClose,
  };
}
