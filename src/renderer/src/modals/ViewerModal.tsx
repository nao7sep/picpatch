// The viewer: one image at a time, fitted or at actual size, with the previous and
// next image a key away. Compare puts a second image beside it, or over it with a
// wipe when both are the same size.
import { useEffect, useRef, useState } from 'react';
import type { Run, Session } from '../../../shared/session.ts';
import { modelLabel } from '../models.ts';
import { wipeCompatible } from '../../../shared/viewport.ts';
import { imageUrl } from '../api.ts';
import type { ViewItem } from '../components/Conversation.tsx';
import { ChevronLeftIcon, ChevronRightIcon, CompareIcon, ReuseIcon, SaveIcon, TargetIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';
import { imageLabel } from '../transcript.ts';
import { Modal } from './Modal.tsx';

interface Natural { width: number; height: number }

export function ViewerModal({ session, items, index: initial, onClose, onEditThis, onSave, onReuse }: {
  session: Session; items: ViewItem[]; index: number; onClose: () => void;
  onEditThis: (runId: string) => void; onSave: (runId: string, index: number) => void; onReuse: (run: Run) => void;
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(Math.max(0, initial));
  const [actual, setActual] = useState(false);
  const [second, setSecond] = useState<number>();
  const [mode, setMode] = useState<'side' | 'wipe'>('side');
  const [wipe, setWipe] = useState(50);
  const [sizes, setSizes] = useState<Record<string, Natural>>({});
  const stage = useRef<HTMLDivElement>(null);
  const item = items[index]!;
  const run = item.run ? session.runs.find(entry => entry.id === item.run) : undefined;
  const other = second !== undefined ? items[second] : undefined;
  const canWipe = other && sizes[item.key] && sizes[other.key] && wipeCompatible(sizes[item.key]!, sizes[other.key]!);
  const showWipe = other && mode === 'wipe' && canWipe;
  const go = (step: number) => { setIndex(value => Math.max(0, Math.min(items.length - 1, value + step))); };

  useEffect(() => { if (second === index) setSecond(undefined); }, [index, second]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || (event.target as HTMLElement).closest('input,select')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
  };
  const loaded = (key: string) => (event: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    setSizes(value => value[key] ? value : { ...value, [key]: { width, height } });
  };
  const caption = (entry: ViewItem) => {
    const owner = entry.run ? session.runs.find(r => r.id === entry.run) : undefined;
    const size = sizes[entry.key];
    return [imageLabel(session, entry.key, t), owner && modelLabel(owner.modelId), size && t('conversation.size', { width: String(size.width), height: String(size.height) })].filter(Boolean).join(', ');
  };

  return (
    <Modal title={t('viewer.title')} large onClose={onClose} className="viewer" footer={
      <div className="viewer-bar" onKeyDown={onKeyDown}>
        <button type="button" className="icon-button" disabled={index === 0} onClick={() => go(-1)} aria-label={t('viewer.previous')} title={t('viewer.previous')}><ChevronLeftIcon /></button>
        <span className="viewer-count">{t('viewer.count', { index: index + 1, count: items.length })}</span>
        <button type="button" className="icon-button" disabled={index === items.length - 1} onClick={() => go(1)} aria-label={t('viewer.next')} title={t('viewer.next')}><ChevronRightIcon /></button>
        <div className="segmented" role="radiogroup" aria-label={t('viewer.scale')}>
          <label className={!actual ? 'on' : undefined}><input type="radio" name="viewer-scale" checked={!actual} onChange={() => setActual(false)} /><span>{t('ui.fit')}</span></label>
          <label className={actual ? 'on' : undefined}><input type="radio" name="viewer-scale" checked={actual} onChange={() => setActual(true)} /><span>{t('viewer.actual')}</span></label>
        </div>
        <label className="viewer-compare">
          <CompareIcon />
          <select aria-label={t('viewer.compareWith')} value={second ?? ''} onChange={event => setSecond(event.target.value === '' ? undefined : Number(event.target.value))}>
            <option value="">{t('viewer.noCompare')}</option>
            {items.map((entry, position) => position === index ? null : <option key={entry.key} value={position}>{imageLabel(session, entry.key, t)}</option>)}
          </select>
        </label>
        {other && (
          <select aria-label={t('ui.comparison_layout')} value={canWipe ? mode : 'side'} onChange={event => setMode(event.target.value as 'side' | 'wipe')}>
            <option value="side">{t('ui.side_by_side')}</option>
            <option value="wipe" disabled={!canWipe}>{t('ui.wipe_matching_sizes')}</option>
          </select>
        )}
        {showWipe && <input type="range" min={0} max={100} value={wipe} aria-label={t('ui.wipe_position')} onChange={event => setWipe(Number(event.target.value))} />}
        <span className="spacer" />
        {run?.output && <>
          <button type="button" className="quiet-button" onClick={() => onEditThis(run.id)}><TargetIcon /><span>{t('ui.edit_this_result')}</span></button>
          <button type="button" className="quiet-button" onClick={() => onSave(run.id, index)}><SaveIcon /><span>{t('ui.save_image')}</span></button>
          <button type="button" className="quiet-button" onClick={() => onReuse(run)}><ReuseIcon /><span>{t('ui.reuse_settings')}</span></button>
        </>}
        <button type="button" className="button" onClick={onClose}>{t('ui.close')}</button>
      </div>
    }>
      <div ref={stage} className={`viewer-stage${actual ? ' actual' : ''}${other && !showWipe ? ' pair' : ''}`} tabIndex={0} aria-label={caption(item)} onKeyDown={onKeyDown}>
        {showWipe ? (
          <figure className="viewer-figure wipe">
            <img src={imageUrl(session.id, item.key)} alt={caption(item)} draggable={false} onLoad={loaded(item.key)} />
            <img className="wipe-top" src={imageUrl(session.id, other.key)} alt={caption(other)} draggable={false} onLoad={loaded(other.key)} style={{ clipPath: `inset(0 0 0 ${wipe}%)` }} />
          </figure>
        ) : (
          <>
            <figure className="viewer-figure">
              <img src={imageUrl(session.id, item.key)} alt={caption(item)} draggable={false} onLoad={loaded(item.key)} onClick={() => setActual(value => !value)} />
              {other && <figcaption>{caption(item)}</figcaption>}
            </figure>
            {other && (
              <figure className="viewer-figure">
                <img src={imageUrl(session.id, other.key)} alt={caption(other)} draggable={false} onLoad={loaded(other.key)} />
                <figcaption>{caption(other)}</figcaption>
              </figure>
            )}
          </>
        )}
      </div>
      {!other && <p className="viewer-caption">{caption(item)}</p>}
    </Modal>
  );
}
