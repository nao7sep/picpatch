import { isComposing } from './ime.ts';
interface Item { key: string; label: string; element: HTMLButtonElement }
interface Options { label: string; selected: string[]; multiple?: boolean; horizontal?: boolean; empty: string; select: (keys: string[]) => void }
const active = new WeakMap<HTMLElement, string>();
const positions = new WeakMap<HTMLElement, number>();
const anchors = new WeakMap<HTMLElement, string>();
/** Manual activation and roving focus, shared by the session and result collections. */
export function renderCollection(holder: HTMLElement, items: Item[], options: Options) {
  const hadFocus = holder.contains(document.activeElement);
  const previous = active.get(holder);
  const found = items.findIndex(item => item.key === previous);
  let index = found >= 0 ? found : Math.min(positions.get(holder) ?? 0, Math.max(0, items.length - 1));
  let selection = [...options.selected];
  holder.setAttribute('role', 'listbox'); holder.setAttribute('aria-label', options.label);
  if (options.multiple) holder.setAttribute('aria-multiselectable', 'true');
  holder.replaceChildren(...items.map(item => item.element)); holder.tabIndex = items.length ? -1 : 0;
  if (!items.length) { holder.textContent = options.empty; if (hadFocus) holder.focus(); return; }
  function paint() { items.forEach((item, i) => { item.element.tabIndex = i === index ? 0 : -1; item.element.setAttribute('aria-selected', String(selection.includes(item.key))); item.element.classList.toggle('selected', selection.includes(item.key)); }); }
  function focus(i: number) { index = Math.max(0, Math.min(items.length - 1, i)); active.set(holder, items[index]!.key); positions.set(holder, index); paint(); items[index]!.element.focus(); items[index]!.element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  function choose(i: number, event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) {
    const key = items[i]!.key;
    if (options.multiple && event.shiftKey) {
      const anchor = Math.max(0, items.findIndex(item => item.key === anchors.get(holder)));
      selection = items.slice(Math.min(anchor, i), Math.max(anchor, i) + 1).map(item => item.key);
    } else {
      selection = options.multiple && (event.ctrlKey || event.metaKey) ? selection.includes(key) ? selection.filter(value => value !== key) : [...selection, key] : [key];
      anchors.set(holder, key);
    }
    paint(); options.select([...selection]);
  }
  let typed = ''; let typedAt = 0;
  for (const [i, item] of items.entries()) {
    item.element.setAttribute('role', 'option'); item.element.dataset.key = item.key;
    item.element.onfocus = () => { index = i; active.set(holder, item.key); positions.set(holder, i); paint(); };
    item.element.onclick = event => { focus(i); choose(i, event); };
    item.element.onkeydown = event => {
      if (isComposing(event)) return;
      const movement = event.key === (options.horizontal ? 'ArrowRight' : 'ArrowDown') ? 1 : event.key === (options.horizontal ? 'ArrowLeft' : 'ArrowUp') ? -1 : event.key === 'PageDown' ? 5 : event.key === 'PageUp' ? -5 : 0;
      if (movement || event.key === 'Home' || event.key === 'End') { event.preventDefault(); focus(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : i + movement); if (options.multiple && event.shiftKey) choose(index, event); }
      else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); choose(i, { ...event, ctrlKey: options.multiple && event.key === ' ' || event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { const now = Date.now(); typed = now - typedAt < 800 ? typed + event.key : event.key; typedAt = now; const found = items.findIndex(entry => entry.label.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase())); if (found >= 0) { event.preventDefault(); focus(found); } }
    };
  }
  paint(); if (hadFocus) focus(index);
}
