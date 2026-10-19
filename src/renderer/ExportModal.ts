import { modal } from './Modal.ts';
/** Prompt disclosure is explicit for each sidecar export; dismissal never exports. */
export function exportModal() {
  const surface = document.getElementById('exportOptions') as HTMLDialogElement;
  const include = document.getElementById('includePrompts') as HTMLInputElement;
  const shell = modal(surface, document.getElementById('cancelExport') as HTMLButtonElement);
  let settle: ((value: boolean | undefined) => void) | undefined;
  let answer: boolean | undefined;
  document.getElementById('confirmExport')!.onclick = () => { answer = include.checked; shell.close(); };
  surface.addEventListener('close', () => { const resolve = settle; settle = undefined; resolve?.(answer); });
  return () => new Promise<boolean | undefined>(resolve => { settle = resolve; answer = undefined; include.checked = false; shell.open(); });
}
