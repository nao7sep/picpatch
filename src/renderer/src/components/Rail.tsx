// The session rail: each session is found by its latest picture. One tab stop: a
// listbox whose active row follows the arrow keys and opens that session.
import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../../shared/session.ts';
import { layout, railWidth } from '../../../shared/layout.ts';
import { imageUrl } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';
import { relativeTime } from '../time.ts';
import { AppMenu } from './AppMenu.tsx';
import { ImageIcon, PlusIcon } from './icons.tsx';

export interface RailProps {
  sessions: readonly SessionSummary[];
  failures: number;
  currentId: string | undefined;
  /** Sessions with a run executing now. */
  working: ReadonlySet<string>;
  width: number;
  optionsPane: boolean;
  onWidth: (width: number) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMenu: (command: string) => void;
}

export function Rail(props: RailProps) {
  const { t } = useI18n();
  const { sessions, currentId } = props;
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const width = railWidth(drag ?? props.width, windowWidth, props.optionsPane);
  const activeIndex = sessions.findIndex(session => session.id === currentId);

  useEffect(() => { if (activeIndex >= 0) document.getElementById(`session-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || !sessions.length) return;
    const move = (index: number) => {
      event.preventDefault();
      const next = sessions[Math.max(0, Math.min(sessions.length - 1, index))];
      if (next && next.id !== currentId) props.onOpen(next.id);
    };
    switch (event.key) {
      case 'ArrowDown': move(activeIndex < 0 ? 0 : activeIndex + 1); break;
      case 'ArrowUp': move(activeIndex < 0 ? 0 : activeIndex - 1); break;
      case 'Home': move(0); break;
      case 'End': move(sessions.length - 1); break;
      case 'PageDown': move(activeIndex + 8); break;
      case 'PageUp': move(activeIndex - 8); break;
      case 'F2': event.preventDefault(); props.onRename(); break;
      case 'Delete': event.preventDefault(); props.onDelete(); break;
      case 'Backspace': if (event.metaKey) { event.preventDefault(); props.onDelete(); } break;
    }
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX, startWidth = width, target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = startWidth;
    const move = (e: PointerEvent) => { latest = Math.max(layout.rail, Math.min(layout.railMax, startWidth + e.clientX - startX)); setDrag(latest); };
    const up = () => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
      setDrag(null);
      // Only a drag saves, and it saves the intent rather than a clamp the window imposed.
      if (latest !== startWidth) props.onWidth(latest);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  };
  const onSplitterKey = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent)) return;
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.onWidth(Math.max(layout.rail, Math.min(layout.railMax, width + (event.key === 'ArrowRight' ? step : -step)))); }
    else if (event.key === 'Home') { event.preventDefault(); props.onWidth(layout.railDefault); }
  };

  return (
    <>
      <nav className="rail" style={{ width }} aria-label={t('ui.sessions')}>
        <div className="rail-top">
          <span className="app-name">PicPatch</span>
          <button type="button" className="icon-button" onClick={props.onNew} aria-label={t('ui.new_session')} title={t('ui.new_session')}><PlusIcon /></button>
          <AppMenu onCommand={props.onMenu} />
        </div>
        <div
          className="session-list" role="listbox" tabIndex={0} aria-label={t('ui.sessions')}
          aria-activedescendant={activeIndex >= 0 ? `session-${activeIndex}` : undefined} onKeyDown={onKeyDown}
        >
          {sessions.map((session, index) => (
            <div
              key={session.id} id={`session-${index}`} role="option" aria-selected={session.id === currentId}
              className={`session-row${session.id === currentId ? ' selected' : ''}`}
              onClick={() => { if (session.id !== currentId) props.onOpen(session.id); }}
              onDoubleClick={() => { if (session.id === currentId) props.onRename(); }}
            >
              <span className="session-cover">
                {session.cover ? <img src={imageUrl(session.id, session.cover, true)} alt="" draggable={false} /> : <ImageIcon />}
                {props.working.has(session.id) && <span className="session-working" aria-hidden="true" />}
              </span>
              <span className="session-text">
                <span className="session-title">{session.name}</span>
                <span className="session-meta">
                  {props.working.has(session.id) ? t('rail.working') : (session.results ? t('rail.meta', { when: relativeTime(session.updated), count: session.results }) : relativeTime(session.updated))}
                </span>
              </span>
            </div>
          ))}
          {!sessions.length && <p className="rail-note">{t('ui.no_saved_sessions')}</p>}
          {props.failures > 0 && <p className="rail-note">{t('rail.unreadable', { count: props.failures })}</p>}
        </div>
      </nav>
      <div
        className="splitter" role="separator" aria-orientation="vertical" tabIndex={0}
        aria-valuemin={layout.rail} aria-valuemax={layout.railMax} aria-valuenow={Math.round(width)} aria-label={t('rail.resize')}
        onPointerDown={startDrag} onKeyDown={onSplitterKey}
      />
    </>
  );
}
