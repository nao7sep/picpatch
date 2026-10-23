// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { modalLayoutProblems } from '../../src/main/qualification-layout.ts';
afterEach(() => document.body.replaceChildren());
function dialogFixture() {
  const dialog = document.createElement('div'); document.body.append(dialog);
  let selected = 0;
  const mount = () => {
    dialog.innerHTML = '<div class="modal-head"></div><div class="modal-body"></div><div class="modal-foot"></div>';
    for (const [index, name] of ['First', 'Last'].entries()) {
      const tab = document.createElement('button'); tab.role = 'tab'; tab.textContent = name;
      tab.onclick = () => { selected = index; mount(); dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]!.focus(); };
      dialog.append(tab);
    }
    dialog.querySelector<HTMLElement>('.modal-foot')!.getBoundingClientRect = () => ({ top: 100, bottom: selected === 0 ? 900 : 200 } as DOMRect);
  };
  mount(); return dialog;
}
it('retains an earlier tab geometry failure after a healthy final tab remounts every tab control', async () => {
  const dialog = dialogFixture();
  const problems = await modalLayoutProblems(dialog, async () => {}, 700);
  expect(problems).toContain('First: footer left viewport');
  expect(problems.some(problem => problem.startsWith('Last:'))).toBe(false);
  expect(document.activeElement?.textContent).toBe('Last');
});
it('checks untabbed dialog overflow, band overlap and clipped captions', async () => {
  const dialog = document.createElement('div'); dialog.tabIndex = 0; document.body.append(dialog);
  dialog.innerHTML = '<div class="modal-head"></div><div class="modal-body"></div><button>Save</button>';
  dialog.focus();
  Object.defineProperties(dialog, { scrollWidth: { value: 600 }, clientWidth: { value: 400 } });
  dialog.querySelector<HTMLElement>('.modal-head')!.getBoundingClientRect = () => ({ bottom: 80 } as DOMRect);
  dialog.querySelector<HTMLElement>('.modal-body')!.getBoundingClientRect = () => ({ top: 50, bottom: 150 } as DOMRect);
  const button = dialog.querySelector('button')!;
  Object.defineProperties(button, { scrollWidth: { value: 100 }, clientWidth: { value: 50 } });
  button.getClientRects = () => [new DOMRect()] as unknown as DOMRectList;
  expect(await modalLayoutProblems(dialog, async () => {}, 700)).toEqual(['dialog: bands overlap', 'dialog: horizontal overflow', 'dialog: clipped Save']);
});
