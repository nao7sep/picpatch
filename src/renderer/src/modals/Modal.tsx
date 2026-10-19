// The one modal shell (modal-dialog-conventions): title, scrolling body and footer
// bands over a scrim; focus kept inside and returned on close. Every close path
// (Escape, the X, the scrim, Close Window) goes through the surface's onClose guard.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open surfaces, oldest first; Close Window and quit decisions act on the last. */
const stack: { close: () => void }[] = [];
const listeners = new Set<(open: number) => void>();
export function closeTopModal(): boolean {
  const top = stack.at(-1); if (!top) return false;
  if (!isComposing()) top.close();
  return true;
}
export const modalOpen = () => stack.length > 0;
export function onModalCount(listener: (open: number) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const announce = () => { for (const listener of listeners) listener(stack.length); };

export interface ModalProps {
  title: string;
  onClose: () => void;
  /** A chosen width in px within the fleet range for the surface's kind. */
  width?: number;
  /** A surface that works on an image: 85% of the window both ways. */
  large?: boolean;
  footer?: ReactNode;
  band?: ReactNode;
  /** About-style surfaces name themselves in their content; the title stays for assistive technology. */
  hideTitle?: boolean;
  /** While true, the scrim does not close the surface (drafts, busy work). */
  guarded?: boolean;
  describedBy?: string;
  className?: string;
  children?: ReactNode;
}

export function Modal({ title, onClose, width = 460, large, footer, band, hideTitle, guarded, describedBy, className, children }: ModalProps) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const entry = { close: () => closeRef.current() };
    stack.push(entry); announce();
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current!;
    const preferred = root.querySelector<HTMLElement>('[data-autofocus]');
    const first = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(el => !el.dataset.destructive && !el.dataset.close);
    (preferred ?? first ?? root).focus();
    return () => {
      stack.splice(stack.indexOf(entry), 1); announce();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
    if (event.key !== 'Tab') return;
    const items = [...panel.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0]!, last = items.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="scrim" onMouseDown={event => { if (event.target === event.currentTarget && !guarded) closeRef.current(); }}>
      <div
        ref={panel}
        className={`modal${large ? ' modal-large' : ''}${hideTitle ? ' modal-panel' : ''}${className ? ` ${className}` : ''}`}
        role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} tabIndex={-1}
        style={large ? undefined : { width }}
        onKeyDown={onKeyDown}
      >
        <header className="modal-head">
          <h2 id={titleId} className={hideTitle ? 'visually-hidden' : undefined}>{title}</h2>
          <button type="button" className="icon-button modal-close" data-close="true" aria-label={t('ui.close')} title={t('ui.close')} onClick={() => closeRef.current()}>
            <CloseIcon />
          </button>
        </header>
        {band && <div className="modal-band">{band}</div>}
        {children ? <div className="modal-body">{children}</div> : null}
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
