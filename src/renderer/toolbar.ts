import { isComposing } from './ime.ts';
/** Action buttons only: adjacent native form controls retain their own navigation. */
export function toolbar(holder: HTMLElement) {
  const buttons = [...holder.querySelectorAll<HTMLButtonElement>('button')];
  let active: HTMLButtonElement | undefined = buttons[0];
  let ownsFocus = false;
  const eligible = () => buttons.filter(button => !button.disabled && !button.hidden);
  function paint() {
    const available = eligible();
    if (!active || !available.includes(active)) {
      const position = active ? buttons.indexOf(active) : 0;
      active = available.find(button => buttons.indexOf(button) >= position) ?? available.at(-1);
    }
    buttons.forEach(button => { button.tabIndex = button === active ? 0 : -1; });
    holder.tabIndex = active ? -1 : 0;
  }
  function focus(button: HTMLButtonElement) { active = button; paint(); button.focus(); button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  const trackFocus = (event: FocusEvent) => { ownsFocus = event.target instanceof Node && holder.contains(event.target); };
  document.addEventListener('focusin', trackFocus);
  holder.addEventListener('focusin', event => { if (event.target instanceof HTMLButtonElement) { active = event.target; paint(); } });
  holder.addEventListener('keydown', event => {
    if (isComposing(event) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const available = eligible(); const index = available.indexOf(active!);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : undefined;
    if (next === undefined || !available.length) return;
    event.preventDefault(); focus(available[Math.max(0, Math.min(next, available.length - 1))]!);
  });
  // Disabled/hidden result actions change after background renders; don't steal outside focus.
  const observer = new MutationObserver(() => {
    const focused = ownsFocus && (holder.contains(document.activeElement) || document.activeElement === document.body);
    paint(); if (focused) (active ?? holder).focus();
  });
  observer.observe(holder, { subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
  paint();
  window.addEventListener('pagehide', () => { observer.disconnect(); document.removeEventListener('focusin', trackFocus); }, { once: true });
}
