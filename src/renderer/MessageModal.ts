import { t } from '../shared/i18n/index.ts';
import type { AppMessage } from '../shared/messages.ts';
import { modal } from './Modal.ts';
/** The single queued app message surface. Undefined means dismissal, never consent. */
export function messageModal() {
  const surface = document.getElementById('appMessage') as HTMLDialogElement;
  const cancel = document.getElementById('messageCancel') as HTMLButtonElement;
  const footer = surface.querySelector('footer')!;
  const shell = modal(surface, cancel);
  type Pending = { message: AppMessage; resolve: (value: number | undefined) => void };
  const queue: Pending[] = [];
  let active: Pending | undefined;
  let answer: number | undefined;
  function show() {
    if (active || !queue.length) return;
    active = queue.shift()!; answer = undefined;
    const { title, detail, actions } = active.message;
    surface.querySelector('h2')!.textContent = t(title.key, title.values);
    const body = surface.querySelector<HTMLElement>('.modalBody')!;
    body.textContent = detail ? t(detail.key, detail.values) : ''; body.hidden = !detail;
    cancel.textContent = t(actions[0]!.label.key, actions[0]!.label.values);
    footer.replaceChildren(cancel);
    actions.slice(1).forEach((action, index) => {
      const button = document.createElement('button');
      button.textContent = t(action.label.key, action.label.values);
      if (action.destructive) button.className = 'danger';
      button.onclick = () => { answer = index + 1; shell.close(); };
      footer.append(button);
    });
    shell.open();
  }
  surface.addEventListener('close', () => {
    const pending = active; active = undefined;
    pending?.resolve(answer); show();
  });
  return {
    ask(message: AppMessage): Promise<number | undefined> {
      return new Promise(resolve => { queue.push({ message, resolve }); show(); });
    },
    dismissAll() {
      for (const pending of queue.splice(0)) pending.resolve(undefined);
      answer = undefined;
      if (surface.open) shell.close();
    },
  };
}
