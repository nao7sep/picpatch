// A small non-modal panel anchored to its trigger (the model and size pickers). It
// closes on Escape, an outside press or Tab leaving it, and returns focus to the trigger.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isComposing } from '../ime.ts';

export function Popover({ label, trigger, triggerClass = 'chip-button', disabled, placement = 'above-start', children }: {
  label: string; trigger: ReactNode; triggerClass?: string; disabled?: boolean; placement?: 'above-start' | 'below-end';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { setOpen(false); if (restore) button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div className={`menu-anchor ${placement}`}>
      <button ref={button} type="button" className={triggerClass} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} title={label} onClick={() => setOpen(value => !value)}>
        {trigger}
      </button>
      {open && (
        <div
          ref={panel} className="popover" role="dialog" aria-label={label} tabIndex={-1}
          onKeyDown={event => { if (event.key === 'Escape' && !isComposing(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); close(); } }}
          onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node) && event.relatedTarget && event.relatedTarget !== button.current) setOpen(false); }}
        >
          {children(() => close())}
        </div>
      )}
    </div>
  );
}
