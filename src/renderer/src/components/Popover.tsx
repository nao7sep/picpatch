// A small non-modal panel anchored to its trigger (the model and size pickers). It
// closes on Escape, an outside press or Tab leaving it, and returns focus to the trigger.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isComposing } from '../ime.ts';

export function Popover({ label, trigger, triggerClass = 'chip-button', disabled, placement = 'above-start', children }: {
  label: string; trigger: ReactNode; triggerClass?: string; disabled?: boolean; placement?: 'above-start' | 'below-end';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof placePopover>>();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { setOpen(false); if (restore) button.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const place = () => {
      if (button.current && panel.current) setPosition(placePopover(button.current.getBoundingClientRect(), panel.current.getBoundingClientRect(), window.innerWidth, window.innerHeight, placement));
    };
    place();
    const observer = new ResizeObserver(place); if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, placement]);
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
          ref={panel} style={position} className="popover" role="dialog" aria-label={label} tabIndex={-1}
          onKeyDown={event => { if (event.key === 'Escape' && !isComposing(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); close(); } }}
          onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node) && event.relatedTarget && event.relatedTarget !== button.current) setOpen(false); }}
        >
          {children(() => close())}
        </div>
      )}
    </div>
  );
}

/** Keep the entire measured panel inside the viewport, including triggers near either edge. */
export function placePopover(trigger: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, panel: Pick<DOMRect, 'width' | 'height'>, width: number, height: number, placement: 'above-start' | 'below-end') {
  const margin = 8;
  const maxWidth = Math.max(0, width - margin * 2), maxHeight = Math.max(0, height - margin * 2);
  const panelWidth = Math.min(panel.width, maxWidth), panelHeight = Math.min(panel.height, maxHeight);
  const preferredLeft = placement === 'above-start' ? trigger.left : trigger.right - panelWidth;
  const preferredTop = placement === 'above-start' ? trigger.top - panelHeight - 6 : trigger.bottom + 4;
  return { position: 'fixed' as const, left: Math.max(margin, Math.min(preferredLeft, width - margin - panelWidth)), top: Math.max(margin, Math.min(preferredTop, height - margin - panelHeight)), right: 'auto', bottom: 'auto', maxWidth, maxHeight, overflowY: 'auto' as const };
}
