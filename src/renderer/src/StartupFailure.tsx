// A root surface, not a stacked modal: shown instead of the workspace when its first
// load fails, so the app never runs half-initialized. Raw error text is never shown;
// Records keeps the diagnostics.
import { useEffect, useRef } from 'react';
import { useI18n } from './i18n.tsx';

/** With `collection`, the chosen session folder is missing; another one can be opened from here. */
export function StartupFailure({ retrying, onRetry, onQuit, collection, onOpenCollection }: { retrying: boolean; onRetry: () => void; onQuit: () => void; collection?: string; onOpenCollection?: () => void }) {
  const { t } = useI18n();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  return (
    <main className="startup-failure" aria-labelledby="startup-title">
      <div className="startup-card">
        <h1 id="startup-title" ref={title} tabIndex={-1}>{t(collection === undefined ? 'startup.title' : 'collection.unavailableTitle')}</h1>
        <p role="alert">{collection === undefined ? t('startup.detail') : t('collection.unavailableDetail', { path: collection })}</p>
        <div className="startup-actions">
          <button type="button" className="button" onClick={onQuit}>{t('native.quit')}</button>
          {collection !== undefined && onOpenCollection && <button type="button" className="button" disabled={retrying} onClick={onOpenCollection}>{t('collection.open')}</button>}
          <button type="button" className="button primary" disabled={retrying} onClick={onRetry}>{t('ui.retry')}</button>
        </div>
      </div>
    </main>
  );
}
