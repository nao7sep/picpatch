// A root surface, not a stacked modal: shown instead of the workspace when its first
// load fails, so the app never runs half-initialized. Raw error text is never shown;
// Records keeps the diagnostics.
import { useEffect, useRef } from 'react';
import { useI18n } from './i18n.tsx';

export function StartupFailure({ retrying, onRetry, onQuit }: { retrying: boolean; onRetry: () => void; onQuit: () => void }) {
  const { t } = useI18n();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  return (
    <main className="startup-failure" aria-labelledby="startup-title">
      <div className="startup-card">
        <h1 id="startup-title" ref={title} tabIndex={-1}>{t('startup.title')}</h1>
        <p role="alert">{t('startup.detail')}</p>
        <div className="startup-actions">
          <button type="button" className="button" onClick={onQuit}>{t('native.quit')}</button>
          <button type="button" className="button primary" disabled={retrying} onClick={onRetry}>{t('startup.retry')}</button>
        </div>
      </div>
    </main>
  );
}
