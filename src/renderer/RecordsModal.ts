import { errorText } from '../shared/i18n/index.ts';
import { modal } from './Modal.ts';
import type { Bridge } from '../shared/bridge.ts';
export function recordsModal(api: Bridge) {
  const surface = document.getElementById('records') as HTMLDialogElement;
  const shell = modal(surface, document.getElementById('closeRecords') as HTMLButtonElement);
  document.getElementById('showRecords')!.onclick = () => {
    shell.open();
    void api.call('records').then(items => { document.getElementById('recordLines')!.textContent = items.map((item: unknown) => JSON.stringify(item)).join('\n'); }).catch(error => { document.getElementById('recordLines')!.textContent = errorText(error); });
  };
}
