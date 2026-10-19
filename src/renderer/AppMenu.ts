import { isComposing } from './ime.ts';
import { shortcuts, shortcutText } from '../shared/shortcuts.ts';
/** Command menu: manual activation, clamped arrows, one tab stop on its trigger. */
export function appMenu(trigger: HTMLButtonElement, menu: HTMLElement) {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
  let active = 0, search = '', typedAt = 0;
  items.forEach(item => {
    item.tabIndex = -1;
    const shortcut = shortcuts.find(shortcut => shortcut.id === item.id);
    if (shortcut) item.dataset.shortcut = shortcutText(shortcut, /Mac/.test(navigator.platform));
  });
  function close(restore = true) { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (restore) trigger.focus(); }
  function focus(index: number) { active = Math.max(0, Math.min(index, items.length - 1)); items[active]!.focus(); items[active]!.scrollIntoView({ block: 'nearest' }); }
  function open(last = false) {
    menu.hidden = false; trigger.setAttribute('aria-expanded','true');
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 8}px`; menu.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
    search = ''; focus(last ? items.length - 1 : 0);
  }
  trigger.onclick = () => { if (menu.hidden) open(); else close(); };
  trigger.onkeydown = event => { if (isComposing(event)) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(event.key === 'ArrowUp'); } };
  // Close before the existing action opens a modal, so focus returns to the menu trigger.
  menu.addEventListener('click', event => { if ((event.target as HTMLElement).closest('[role=menuitem]')) close(); }, true);
  menu.onkeydown = event => {
    if (isComposing(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close();
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); focus(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== ' ') {
      event.preventDefault(); const now = Date.now(); search = (now - typedAt < 700 ? search : '') + event.key.toLocaleLowerCase(); typedAt = now;
      const found = items.findIndex(item => item.textContent?.trim().toLocaleLowerCase().startsWith(search)); if (found >= 0) focus(found);
    }
  };
  const outside = (event: PointerEvent) => { if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) close(false); };
  document.addEventListener('pointerdown', outside);
  window.addEventListener('pagehide', () => document.removeEventListener('pointerdown', outside), { once: true });
}
