// The one menu layer, so every menu behaves alike: a trigger that is the
// single tab stop and a popover of commands. Arrows move and stop at the ends,
// typing jumps by label, Enter chooses, Escape and Tab close.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isComposing } from '../ime.ts';

export interface MenuItem { id: string; label: string; keys?: string; disabled?: boolean }
export type MenuEntry = MenuItem | 'separator';

export interface MenuProps {
  label: string;
  trigger: ReactNode;
  triggerClass?: string;
  entries: readonly MenuEntry[];
  placement?: 'below-start' | 'below-end' | 'above-start';
  disabled?: boolean;
  onChoose: (id: string) => void;
}

export function Menu({ label, trigger, triggerClass = 'icon-button', entries, placement = 'below-start', disabled, onChoose }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [keyboard, setKeyboard] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();
  const items = entries.filter((entry): entry is MenuItem => entry !== 'separator');

  useEffect(() => {
    if (!open) return;
    menu.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => { document.getElementById(`${id}-item-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, id]);

  const show = (last: boolean, byKeyboard: boolean) => { setKeyboard(byKeyboard); setActive(last ? items.length - 1 : 0); setOpen(true); };
  const close = (restore = true) => { setOpen(false); if (restore) button.current?.focus(); };
  const choose = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return;
    close(); onChoose(item.id);
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent)) return;
    setKeyboard(true);
    const move = (index: number) => { event.preventDefault(); setActive(Math.max(0, Math.min(items.length - 1, index))); };
    switch (event.key) {
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(); return;
      case 'Tab': close(false); return;
      case 'ArrowDown': move(active + 1); return;
      case 'ArrowUp': move(active - 1); return;
      case 'Home': move(0); return;
      case 'End': move(items.length - 1); return;
      case 'Enter': case ' ': event.preventDefault(); choose(items[active]); return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLocaleLowerCase(), at: now };
      const found = items.findIndex(item => item.label.toLocaleLowerCase().startsWith(typed.current.text));
      if (found >= 0) move(found);
    }
  };

  let index = -1;
  return (
    <div className={`menu-anchor ${placement}`}>
      <button
        ref={button} type="button" className={triggerClass} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} aria-label={label} title={label}
        onClick={event => { if (open) close(false); else show(false, event.detail === 0); }}
        onKeyDown={event => {
          if (isComposing(event.nativeEvent)) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp', true); }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={menu} id={`${id}-menu`} className={`menu-popover${keyboard ? ' keyboard' : ''}`} role="menu" tabIndex={-1} aria-label={label}
          aria-activedescendant={`${id}-item-${active}`} onKeyDown={onKey}
        >
          {entries.map((entry, position) => {
            if (entry === 'separator') return <div key={`separator-${position}`} className="menu-separator" role="separator" />;
            index += 1; const at = index;
            return (
              <div
                key={entry.id} id={`${id}-item-${at}`} role="menuitem" aria-disabled={entry.disabled || undefined}
                className={`menu-item${at === active ? ' active' : ''}${entry.disabled ? ' disabled' : ''}`}
                onClick={() => choose(entry)}
              >
                <span className="menu-label">{entry.label}</span>
                {entry.keys && <span className="menu-keys">{entry.keys}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
