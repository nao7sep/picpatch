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
  closers.set(surface, requestClose);
  surface.addEventListener('cancel', event => { event.preventDefault(); void requestClose(); });
  dismiss.onclick = () => { void requestClose(); };
  surface.addEventListener('close', () => { if (trigger?.isConnected) trigger.focus(); });
  surface.addEventListener('keydown', event => {
    if (isComposing(event)) return;
    if (/Mac/.test(navigator.platform) && event.ctrlKey && !event.metaKey && event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable=true]')) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); event.stopPropagation(); void requestClose(); }
  });
  return {
    open() { trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; surface.showModal(); (options.focus?.() ?? dismiss).focus(); },
    close() { surface.close(); },
    requestClose,
  };
}
