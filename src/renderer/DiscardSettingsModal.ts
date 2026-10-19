import { t } from '../shared/i18n/index.ts';
import { modal } from './Modal.ts';
/** A narrow confirmation: Cancel preserves the still-open settings draft. */
export function discardSettingsModal(): () => Promise<boolean> {
  const surface = document.getElementById('discardSettings') as HTMLDialogElement;
  const cancel = document.getElementById('keepSettings') as HTMLButtonElement;
  const discard = document.getElementById('discardSettingsConfirm') as HTMLButtonElement;
  const shell = modal(surface, cancel);
  let pending: Promise<boolean> | undefined;
  return () => {
    if (pending) return pending;
    surface.querySelector('h2')!.textContent = t('ui.discard_unsaved_settings');
    cancel.textContent = t('ui.cancel'); discard.textContent = t('ui.discard_changes');
    pending = new Promise(resolve => {
      let accepted = false;
      discard.onclick = () => { accepted = true; shell.close(); };
      surface.addEventListener('close', () => { pending = undefined; resolve(accepted); }, { once: true });
      shell.open();
    });
    return pending;
  };
}
