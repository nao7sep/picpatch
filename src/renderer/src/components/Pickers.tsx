// The composer's model and size choices, each a small panel from a chip in its row.
import { useState } from 'react';
import { incompatibilities } from '../../../shared/admission.ts';
import type { Draft } from '../../../shared/session.ts';
import type { CatalogModel, Readiness } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { NumberField } from '../number-field.tsx';
import { modelLabel, modelRows, modelSummary, tierOrder } from '../models.ts';
import { ChevronDownIcon, ShapeIcon } from './icons.tsx';
import { Popover } from './Popover.tsx';


/** Ready models first, then recommended ones to set up; the rest stay behind Show more unless selected. */
export function ModelPicker({ draft, models, hidden = 0, readiness, onDraft, onSetup }: {
  draft: Draft; models: readonly CatalogModel[]; hidden?: number; readiness: Readiness | undefined;
  onDraft: (draft: Draft) => void; onSetup: () => void;
}) {
  const { t, errorText } = useI18n();
  const [more, setMore] = useState(false);
  const [compareEnabled, setCompareEnabled] = useState(draft.modelIds.length > 1);
  const comparing = compareEnabled || draft.modelIds.length > 1;
  const state = (id: string) => { const value = readiness?.[id] ?? 'missing'; return typeof value === 'string' ? value : value.status; };
  const order = (a: CatalogModel, b: CatalogModel) => tierOrder[a.profile.tier] - tierOrder[b.profile.tier] || a.profile.name.localeCompare(b.profile.name) || a.id.localeCompare(b.id);
  const rows = modelRows(models, draft.modelIds, state).map(entry => entry.model);
  const ready = rows.filter(model => state(model.id) === 'ready').sort(order);
  const recommended = rows.filter(model => state(model.id) !== 'ready' && model.profile.tier === 'recommended').sort(order);
  const rest = rows.filter(model => state(model.id) !== 'ready' && model.profile.tier !== 'recommended').sort(order);
  const showRest = more || rest.some(model => draft.modelIds.includes(model.id));
  const label = draft.modelIds.length === 0 ? t('composer.noModel') : comparing ? t('composer.models', { count: draft.modelIds.length }) : modelLabel(draft.modelIds[0]!);
  const unready = draft.modelIds.some(id => state(id) !== 'ready');
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...draft.modelIds.filter(item => item !== id), id] : draft.modelIds.filter(item => item !== id);
    onDraft({ ...draft, modelIds: models.filter(model => next.includes(model.id)).map(model => model.id) });
  };
  const first = draft.modelIds[0] ?? [...ready, ...recommended, ...rest][0]?.id;
  const row = (model: CatalogModel) => {
    const checked = draft.modelIds.includes(model.id);
    const summary = modelSummary(model);
    const unsuited = incompatibilities(draft, model.capabilities)[0];
    return (
      <label key={model.id} className={`picker-row model-row${checked ? ' on' : ''}${unsuited ? ' unsuited' : ''}`} title={unsuited}>
        <input
          type={comparing ? 'checkbox' : 'radio'} name="model" checked={checked} data-autofocus={model.id === first ? 'true' : undefined}
          onChange={event => comparing ? toggle(model.id, event.target.checked) : onDraft({ ...draft, modelIds: [model.id] })}
        />
        <span className="model-text">
          <span className="model-title">
            <span className="picker-name">{model.profile.name}</span>
            <span className="model-tag">{t(model.acquisition === 'pinned' ? 'model.download' : 'model.ownFiles')}</span>
          </span>
          {summary.purposes && <span className="model-line">{summary.purposes}</span>}
          <span className="model-line">{summary.facts}</span>
        </span>
        <span className={`picker-state ${state(model.id)}`}>{typeof readiness?.[model.id] === 'object' ? errorText(readiness[model.id]) : t(`model.${readiness ? state(model.id) : 'checking'}`)}</span>
      </label>
    );
  };
  const group = (heading: string, items: CatalogModel[]) => items.length > 0 && (
    <div className="picker-group" role="presentation">
      <p className="picker-heading">{heading}</p>
      {items.map(row)}
    </div>
  );
  return (
    <Popover label={t('ui.models')} triggerClass={`chip-button${unready ? ' attention' : ''}`} trigger={<><span className={`state-dot ${unready ? 'off' : 'on'}`} aria-hidden="true" /><span className="chip-text">{label}</span><ChevronDownIcon /></>}>
      {close => (
        <div className="picker model-picker">
          <label className="check">
            <input type="checkbox" checked={comparing} onChange={event => { setCompareEnabled(event.target.checked); if (!event.target.checked) onDraft({ ...draft, modelIds: draft.modelIds.slice(-1) }); }} />
            <span>{t('model.compare')}</span>
          </label>
          <fieldset className="picker-list" role={comparing ? 'group' : 'radiogroup'} aria-label={t('ui.models')}>
            {group(t('model.groupReady'), ready)}
            {group(t('model.groupRecommended'), recommended)}
            {showRest && group(t('model.groupMore'), rest)}
          </fieldset>
          {hidden > 0 && <p className="field-help picker-note">{t('model.moreOnMac')}</p>}
          <div className="picker-foot">
            {rest.length > 0 && !rest.some(model => draft.modelIds.includes(model.id)) && (
              <button type="button" className="quiet-button" aria-expanded={showRest} onClick={() => setMore(value => !value)}>{t(showRest ? 'model.showFewer' : 'model.showMore')}</button>
            )}
            <button type="button" className="button compact" onClick={() => { close(); onSetup(); }}>{t('model.fix')}</button>
          </div>
        </div>
      )}
    </Popover>
  );
}

const PRESETS = [
  { key: 'square', width: 1024, height: 1024 },
  { key: 'portrait', width: 832, height: 1216 },
  { key: 'landscape', width: 1216, height: 832 },
] as const;

export function SizePicker({ draft, multiple, onDraft }: { draft: Draft; multiple: number; onDraft: (draft: Draft, save: 'later' | 'now') => void }) {
  const { t } = useI18n();
  const set = (width: number, height: number, save: 'later' | 'now') => onDraft({ ...draft, width, height }, save);
  const preset = PRESETS.find(item => item.width === draft.width && item.height === draft.height);
  const rule = { whole: true, multiple };
  return (
    <Popover label={t('composer.size')} trigger={<><ShapeIcon width={draft.width} height={draft.height} /><span className="chip-text">{t('conversation.size', { width: String(draft.width), height: String(draft.height) })}</span></>}>
      {() => (
        <div className="picker size-picker">
          <div className="segmented" role="radiogroup" aria-label={t('composer.size')}>
            {PRESETS.map(item => (
              <label key={item.key} className={preset?.key === item.key ? 'on' : undefined}>
                <input type="radio" name="size-preset" checked={preset?.key === item.key} data-autofocus={preset?.key === item.key ? 'true' : undefined} onChange={() => set(item.width, item.height, 'now')} />
                <ShapeIcon width={item.width} height={item.height} /><span>{t(`composer.${item.key}`)}</span>
              </label>
            ))}
          </div>
          <div className="size-fields">
            <NumberField id="size.width" label={t('ui.width')} value={draft.width} rule={rule} onCommit={width => set(width!, draft.height, 'later')} />
            <NumberField id="size.height" label={t('ui.height')} value={draft.height} rule={rule} onCommit={height => set(draft.width, height!, 'later')} />
          </div>
          <p className="field-help">{t('composer.sizeRule', { multiple })}</p>
        </div>
      )}
    </Popover>
  );
}
