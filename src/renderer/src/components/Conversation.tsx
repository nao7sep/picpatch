// The open session: a header with its name, then the transcript. Each turn is the
// command as it was sent (text first, then the images it used) and its results,
// each with its own actions. Authored text is rendered literally.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Draft, QueueState, Run, Session } from '../../../shared/session.ts';
import { modelLabel } from '../models.ts';
import { imageUrl } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { commandTurns, imageLabel, imageNumber, pending, type Turn } from '../transcript.ts';
import { elapsed } from '../time.ts';
import { BrushIcon, CanvasIcon, CloseIcon, ExpandIcon, PencilIcon, ReuseIcon, SaveIcon, SlidersIcon, StackIcon, TargetIcon } from './icons.tsx';

export interface ViewItem { key: string; run?: string }

export interface ConversationProps {
  session: Session;
  queue: QueueState;
  target: string | undefined;
  optionsPane: boolean;
  saved: { runId: string; count: number } | undefined;
  onRename: () => void;
  onToggleOptions: () => void;
  onEditThis: (runId: string) => void;
  onReuse: (run: Run) => void;
  onView: (items: ViewItem[], index: number) => void;
  onSave: (runId: string) => void;
  onCancel: (runIds: string[]) => void;
}

export function Conversation(props: ConversationProps) {
  const { t } = useI18n();
  const { session } = props;
  const turns = commandTurns(session.runs);
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // Whether the reader is at the end; results load after layout, so the end moves.
  const pinned = useRef(true);
  const outputs: ViewItem[] = session.runs.filter(run => run.output).map(run => ({ key: run.id, run: run.id }));
  const view = (key: string) => props.onView(outputs, outputs.findIndex(item => item.key === key));

  useLayoutEffect(() => {
    pinned.current = true;
    const element = scroller.current; if (element) element.scrollTop = element.scrollHeight;
  }, [session.runs.length, session.id]);

  useEffect(() => {
    const element = scroller.current, inner = column.current; if (!element || !inner) return;
    const observer = new ResizeObserver(() => { if (pinned.current) element.scrollTop = element.scrollHeight; });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="conversation" aria-label={t('conversation.label')}>
      <header className="conversation-head">
        <button type="button" className="title-button" onClick={props.onRename} title={t('ui.rename_session')}>
          <span className="title-text">{session.name}</span>
          <PencilIcon />
        </button>
        <span className="head-meta">{t('conversation.count', { count: session.runs.filter(run => run.output).length })}</span>
        <button
          type="button" className="icon-button" aria-pressed={props.optionsPane} onClick={props.onToggleOptions}
          aria-label={t('conversation.options')} title={t('conversation.options')}
        >
          <SlidersIcon />
        </button>
      </header>
      <div className="transcript" ref={scroller} tabIndex={0} aria-label={t('ui.results')} onScroll={event => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}>
        <div className="column" ref={column}>
          {turns.length === 0 && (
            <div className="empty-state"><p className="empty-line">{t('conversation.empty')}</p></div>
          )}
          {turns.map(turn => (
            <TurnView key={turn.id} turn={turn} {...props} onViewImage={view} onViewInputs={(items, index) => props.onView(items, index)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TurnView({ turn, session, queue, target, saved, onEditThis, onReuse, onSave, onCancel, onViewImage, onViewInputs }: ConversationProps & { turn: Turn; onViewImage: (key: string) => void; onViewInputs: (items: ViewItem[], index: number) => void }) {
  const { t } = useI18n();
  const draft = turn.draft;
  const inputs = [draft.source, ...draft.references.flatMap(group => group.images)].filter((key): key is string => Boolean(key));
  const viewable = inputs.filter(key => available(session, key)).map(key => ({ key, run: session.runs.some(run => run.id === key) ? key : undefined }));
  const waiting = turn.runs.filter(pending);
  return (
    <article className="turn">
      <div className="command">
        {draft.text ? <p className="command-text">{draft.text}</p> : <p className="command-text muted">{t('conversation.noText')}</p>}
        {(draft.source || draft.references.length > 0) && (
          <div className="command-inputs">
            {draft.source && (
              <InputThumb session={session} imageKey={draft.source} label={t('conversation.edited', { name: imageLabel(session, draft.source, t) })} onOpen={() => onViewInputs(viewable, viewable.findIndex(item => item.key === draft.source))} />
            )}
            {draft.references.map((group, index) => (
              <span key={index} className="command-group">
                <span className="command-group-name"><StackIcon />{t('conversation.group', { name: group.id, role: t(`role.${group.role}`) })}</span>
                <span className="command-group-images">
                  {group.images.map(key => (
                    <InputThumb key={key} session={session} imageKey={key} label={imageLabel(session, key, t)} onOpen={() => onViewInputs(viewable, viewable.findIndex(item => item.key === key))} />
                  ))}
                </span>
              </span>
            ))}
          </div>
        )}
        <CommandFacts draft={draft} count={turn.runs.length} />
      </div>
      <div className={`results${turn.runs.length > 1 ? ' grid' : ''}`}>
        {turn.runs.map(run => (
          <RunResult
            key={run.id} run={run} session={session} queue={queue} isTarget={target === run.id} savedCount={saved?.runId === run.id ? saved.count : 0}
            onEditThis={onEditThis} onReuse={onReuse} onSave={onSave} onCancel={id => onCancel([id])} onView={onViewImage}
          />
        ))}
      </div>
      {waiting.length > 1 && (
        <div className="turn-actions">
          <button type="button" className="button compact" onClick={() => onCancel(waiting.map(run => run.id))}>{t('conversation.cancelAll', { count: waiting.length })}</button>
        </div>
      )}
    </article>
  );
}

function available(session: Session, key: string) {
  return session.assets.some(asset => asset.id === key) || session.runs.some(run => run.id === key && run.output);
}

function InputThumb({ session, imageKey, label, onOpen }: { session: Session; imageKey: string; label: string; onOpen: () => void }) {
  const ready = available(session, imageKey);
  return (
    <button type="button" className="input-thumb" disabled={!ready} onClick={onOpen} title={label} aria-label={label}>
      {ready ? <img src={imageUrl(session.id, imageKey, true)} alt="" loading="lazy" draggable={false} /> : <span className="input-missing" aria-hidden="true" />}
    </button>
  );
}

/** The settings that shaped the command, as quiet marks under it. */
function CommandFacts({ draft, count }: { draft: Draft; count: number }) {
  const { t, number } = useI18n();
  const size = draft.outpaint ?? draft;
  const facts: { icon?: React.ReactNode; text: string }[] = [
    { text: draft.modelIds.map(modelLabel).join(', ') },
    { text: t('conversation.size', { width: String(size.width), height: String(size.height) }) },
  ];
  if (draft.mask) facts.push({ icon: <BrushIcon />, text: t('conversation.masked') });
  if (draft.outpaint) facts.push({ icon: <CanvasIcon />, text: t('conversation.expanded') });
  if (draft.control) facts.push({ icon: <SlidersIcon />, text: t(`control.${draft.control.kind}`) });
  if (count > 1) facts.push({ text: t('conversation.results', { count }) });
  return (
    <ul className="command-facts">
      {facts.map((fact, index) => <li key={index}>{fact.icon}{fact.text}</li>)}
    </ul>
  );
}

function RunResult({ run, session, queue, isTarget, savedCount, onEditThis, onReuse, onSave, onCancel, onView }: {
  run: Run; session: Session; queue: QueueState; isTarget: boolean; savedCount: number;
  onEditThis: (runId: string) => void; onReuse: (run: Run) => void; onSave: (runId: string) => void; onCancel: (runId: string) => void; onView: (key: string) => void;
}) {
  const { t, term, errorText } = useI18n();
  const number = imageNumber(session, run.id);
  const caption = t('conversation.caption', { number, model: modelLabel(run.modelId), seed: String(run.seed) });
  if (pending(run)) return <Developing run={run} queue={queue} caption={caption} onCancel={() => onCancel(run.id)} />;
  if (!run.output) {
    return (
      <div className={`result-failure${run.status === 'cancelled' ? ' quiet' : ''}`} role={run.status === 'cancelled' ? undefined : 'alert'}>
        <p className="result-caption">{caption}</p>
        <p className="result-reason">{run.issue ? errorText(run.issue, run.draft.mode === 'edit' ? 'error.edit' : 'error.generate') : term('status', run.status)}</p>
        <div className="print-actions">
          <button type="button" className="quiet-button" onClick={() => onReuse(run)}><ReuseIcon /><span>{t('ui.reuse_settings')}</span></button>
        </div>
      </div>
    );
  }
  return (
    <figure className={`print${isTarget ? ' target' : ''}`}>
      <button type="button" className="print-mat" onClick={() => onView(run.id)} aria-label={t('conversation.view', { name: t('conversation.image', { number }) })}>
        <img src={imageUrl(session.id, run.id)} alt="" loading="lazy" decoding="async" draggable={false} />
        {isTarget && <span className="print-badge">{t('conversation.editing')}</span>}
      </button>
      <figcaption>
        <p className="result-caption">{caption}</p>
        <div className="print-actions">
          <button type="button" className="quiet-button" aria-pressed={isTarget} onClick={() => onEditThis(run.id)}><TargetIcon /><span>{t('ui.edit_this_result')}</span></button>
          <button type="button" className="quiet-button" onClick={() => onView(run.id)}><ExpandIcon /><span>{t('conversation.viewShort')}</span></button>
          <button type="button" className="quiet-button" onClick={() => onSave(run.id)}><SaveIcon /><span>{t('ui.save_image')}</span></button>
          <button type="button" className="quiet-button" onClick={() => onReuse(run)}><ReuseIcon /><span>{t('ui.reuse_settings')}</span></button>
          {savedCount > 0 && <SavedFlash count={savedCount} />}
        </div>
        {(run.notices ?? []).map((notice, index) => <p key={index} className="result-note">{errorText(notice)}</p>)}
      </figcaption>
    </figure>
  );
}

function SavedFlash({ count }: { count: number }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(true);
  useEffect(() => { setShown(true); const timer = setTimeout(() => setShown(false), 2400); return () => clearTimeout(timer); }, [count]);
  return shown ? <span className="print-status" role="status">{t('ui.image_saved')}</span> : null;
}

/** A queued or running result: a frame of the requested shape with its stage, time and Cancel. */
function Developing({ run, queue, caption, onCancel }: { run: Run; queue: QueueState; caption: string; onCancel: () => void }) {
  const { t, term } = useI18n();
  const active = queue.active?.runId === run.id ? queue.active : undefined;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const size = run.draft.outpaint ?? run.draft;
  const progress = active?.progress;
  return (
    <div className="result-pending" aria-live="polite">
      <div className={`developing${active ? ' active' : ''}`} style={{ aspectRatio: `${size.width} / ${size.height}` }}>
        {active && <div className="developing-sheen" aria-hidden="true" />}
        <div className="developing-label">
          <span>{active ? term('stage', active.stage) : queue.paused ? t('conversation.paused') : t('status.queued')}</span>
          {active && <span className="developing-time">{elapsed(now - active.startedAt)}</span>}
        </div>
        {active && (
          <div className="developing-progress" role="progressbar" aria-label={caption} aria-valuemin={0} aria-valuemax={progress?.total} aria-valuenow={progress?.completed}>
            <span style={progress ? { width: `${Math.round(100 * progress.completed / Math.max(1, progress.total))}%` } : undefined} className={progress ? undefined : 'indeterminate'} />
          </div>
        )}
      </div>
      <p className="result-caption">{caption}</p>
      <div className="print-actions">
        <button type="button" className="quiet-button" onClick={onCancel}><CloseIcon /><span>{t('ui.cancel')}</span></button>
      </div>
    </div>
  );
}
