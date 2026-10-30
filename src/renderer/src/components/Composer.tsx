// The composer: the image being edited and the reference groups as chips above the
// command field; attach, model, size and options below it; Run on the right. It is
// the window's one drop receiver. Enter runs, except while an input method is
// composing; Shift+Enter starts a new line.
import { canPaintMask, hasImage } from '../../../shared/image-command.ts';
import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Draft, Session } from '../../../shared/session.ts';
import { modelLabel } from '../models.ts';
import { imageUrl, type CatalogModel, type Readiness } from '../api.ts';
import type { CommandIssue } from '../command-issues.ts';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';
import { imageLabel } from '../transcript.ts';
import { AttachIcon, BrushIcon, CloseIcon, SendIcon, SlidersIcon, StackIcon } from './icons.tsx';
import { Menu } from './Menu.tsx';
import { ModelPicker, SizePicker } from './Pickers.tsx';

const MAX_ROWS = 10;

export interface ComposerProps {
  session: Session;
  draft: Draft;
  models: readonly CatalogModel[];
  /** Catalog models this computer cannot run, left out of models. */
  hiddenModels: number;
  readiness: Readiness | undefined;
  issues: readonly CommandIssue[];
  submitting: boolean;
  optionsPane: boolean;
  focusRef: MutableRefObject<() => void>;
  onDraft: (draft: Draft, save: 'later' | 'now') => void;
  onSend: () => void;
  onAttachTarget: () => void;
  onAddReference: () => void;
  onDrop: (files: File[]) => void;
  onClearTarget: () => void;
  onPaintMask: () => void;
  onEditReference: (index: number) => void;
  onRemoveReference: (index: number) => void;
  onToggleOptions: () => void;
  onSetup: () => void;
}

export function Composer(props: ComposerProps) {
  const { t } = useI18n();
  const { session, draft } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const [dropping, setDropping] = useState(false);
  props.focusRef.current = () => field.current?.focus();
  const primary = props.models.find(model => model.id === draft.modelIds[0]);
  const multiple = primary?.capabilities.size?.widthMultiple ?? 16;
  const maskable = canPaintMask(session, draft, primary?.capabilities.maskMode);

  useLayoutEffect(() => {
    const element = field.current; if (!element) return;
    element.style.height = 'auto';
    const style = getComputedStyle(element);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    element.style.height = `${Math.min(element.scrollHeight, line * MAX_ROWS + padding)}px`;
  }, [draft.text]);

  const blocked = props.issues.length > 0 || !draft.text.trim() || props.submitting;
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || isComposing(event.nativeEvent)) return;
    event.preventDefault();
    if (!blocked) props.onSend();
  };

  const files = (event: React.DragEvent) => [...event.dataTransfer.types].includes('Files');
  const dropHint = draft.source ? t('composer.dropReferences') : t('composer.dropTarget');

  return (
    <div
      className={`composer-wrap${dropping ? ' dropping' : ''}`} data-drop-receiver="true"
      onDragOver={event => { if (!files(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={event => { if (!files(event)) return; event.preventDefault(); setDropping(false); props.onDrop([...event.dataTransfer.files]); }}
    >
      <div className="composer">
        <IssueLine issues={props.issues} onSetup={props.onSetup} />
        {(draft.source || draft.references.length > 0) && (
          <ul className="chips" aria-label={t('composer.inputs')}>
            {draft.source && (
              <li className={`chip target${draft.mask ? ' masked' : ''}`}>
                <span className="chip-thumb">{hasImage(session, draft.source) ? <img src={imageUrl(session.id, draft.source, true)} alt="" draggable={false} /> : <span className="chip-pending" aria-hidden="true" />}</span>
                <span className="chip-label">
                  <span className="chip-title">{t('conversation.editing')}</span>
                  <span className="chip-name">{imageLabel(session, draft.source, t)}</span>
                </span>
                <button type="button" className="icon-button tiny" aria-pressed={Boolean(draft.mask)} disabled={!maskable} onClick={props.onPaintMask} aria-label={t('ui.paint_mask')} title={draft.mask ? t('composer.masked') : t('ui.paint_mask')}><BrushIcon /></button>
                <button type="button" className="icon-button tiny" onClick={props.onClearTarget} aria-label={t('composer.removeTarget')} title={t('composer.removeTarget')}><CloseIcon /></button>
              </li>
            )}
            {draft.references.map((group, index) => (
              <li key={index} className="chip group">
                <button type="button" className="chip-open" onClick={() => props.onEditReference(index)} title={t('composer.editGroup')}>
                  <span className="chip-stack">
                    {group.images.slice(0, 3).map(key => <img key={key} src={imageUrl(session.id, key, true)} alt="" draggable={false} />)}
                    {!group.images.length && <StackIcon />}
                  </span>
                  <span className="chip-label">
                    <span className="chip-title">{t(`role.${group.role}`)}</span>
                    <span className="chip-name">{group.id}</span>
                  </span>
                </button>
                <button type="button" className="icon-button tiny" onClick={() => props.onRemoveReference(index)} aria-label={t('composer.removeGroup', { name: group.id })} title={t('ui.remove_group')}><CloseIcon /></button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={field} className="composer-field" rows={2} value={draft.text}
          placeholder={draft.source ? t('composer.placeholderEdit') : t('conversation.placeholder')} aria-label={t('conversation.command')}
          onChange={event => props.onDraft({ ...draft, text: event.target.value }, 'later')} onKeyDown={onKeyDown}
        />
        <div className="composer-controls">
          <Menu
            label={t('composer.attach')} trigger={<AttachIcon />} placement="above-start"
            entries={[{ id: 'target', label: t('composer.attachTarget') }, { id: 'reference', label: t('composer.attachReference') }]}
            onChoose={id => id === 'target' ? props.onAttachTarget() : props.onAddReference()}
          />
          <ModelPicker draft={draft} models={props.models} hidden={props.hiddenModels} readiness={props.readiness} onDraft={next => props.onDraft(next, 'now')} onSetup={props.onSetup} />
          <SizePicker draft={draft} multiple={multiple} onDraft={props.onDraft} />
          <button type="button" className="icon-button" aria-pressed={props.optionsPane} onClick={props.onToggleOptions} aria-label={t('conversation.options')} title={t('conversation.options')}><SlidersIcon /></button>
          {dropping && <span className="composer-hint">{dropHint}</span>}
          <span className="spacer" />
          <button type="button" className="send-button" disabled={blocked} onClick={props.onSend} aria-label={t('conversation.send')} title={t('conversation.send')}>
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

/** One line on why Run is unavailable, with Set up when models are missing. */
function IssueLine({ issues, onSetup }: { issues: readonly CommandIssue[]; onSetup: () => void }) {
  const { t, locale } = useI18n();
  const first = issues[0];
  if (!first) return null;
  const text = first.kind === 'field' ? first.text
    : first.kind === 'checking' ? t('model.checking')
    : first.kind === 'unready' ? t('composer.unready', { count: first.models.length, models: new Intl.ListFormat(locale.format, { type: 'conjunction', style: 'narrow' }).format(first.models.map(modelLabel)) })
    : first.kind === 'waiting' ? t('conversation.waiting')
    : first.kind === 'noModel' ? t('composer.chooseModel')
    : first.reason ? t('admission.reason', { model: modelLabel(first.model), reason: first.reason }) : t('admission.unavailable', { model: modelLabel(first.model) });
  return (
    <div className="composer-banner" role="status">
      <span>{issues.length > 1 ? t('composer.issues', { first: text, count: issues.length - 1 }) : text}</span>
      {first.kind === 'unready' && <button type="button" className="link-button" onClick={onSetup}>{t('composer.setUp')}</button>}
    </div>
  );
}
