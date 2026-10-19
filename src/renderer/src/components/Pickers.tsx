// The composer's model and size choices, each a small panel from a chip in its row.
import { modelName } from '../../shared/model-name.ts';
import type { Draft } from '../../app/types.ts';
import type { CatalogModel, Readiness } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { ChevronDownIcon, ShapeIcon } from './icons.tsx';
import { Popover } from './Popover.tsx';

const ORDER = { ready: 0, engineMissing: 1, missing: 2 } as const;

export function ModelPicker({ draft, models, readiness, onDraft, onSetup }: {
  draft: Draft; models: readonly CatalogModel[]; readiness: Readiness | undefined;
  onDraft: (draft: Draft) => void; onSetup: () => void;
}) {
  const { t } = useI18n();
  const comparing = draft.modelIds.length > 1;
  const state = (id: string) => readiness?.[id] ?? 'missing';
  const sorted = [...models].sort((a, b) => ORDER[state(a.id)] - ORDER[state(b.id)] || modelName(a.id).localeCompare(modelName(b.id)));
  const label = draft.modelIds.length === 0 ? t('composer.noModel') : comparing ? t('composer.models', { count: draft.modelIds.length }) : modelName(draft.modelIds[0]!);
  const unready = draft.modelIds.some(id => state(id) !== 'ready');
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...draft.modelIds.filter(item => item !== id), id] : draft.modelIds.filter(item => item !== id);
    onDraft({ ...draft, modelIds: models.filter(model => next.includes(model.id)).map(model => model.id) });
  };
  return (
    <Popover label={t('ui.models')} triggerClass={`chip-button${unready ? ' attention' : ''}`} trigger={<><span className={`state-dot ${unready ? 'off' : 'on'}`} aria-hidden="true" /><span className="chip-text">{label}</span><ChevronDownIcon size={14} /></>}>
      {close => (
        <div className="picker">
          <label className="check">
            <input type="checkbox" checked={comparing} onChange={event => onDraft({ ...draft, modelIds: event.target.checked ? draft.modelIds.slice(0, 1) : draft.modelIds.slice(-1) })} />
            <span>{t('model.compare')}</span>
          </label>
          <fieldset className="picker-list" role={comparing ? 'group' : 'radiogroup'} aria-label={t('ui.models')}>
            {sorted.map((model, index) => {
              const checked = draft.modelIds.includes(model.id);
              return (
                <label key={model.id} className={`picker-row${checked ? ' on' : ''}`}>
                  <input
                    type={comparing ? 'checkbox' : 'radio'} name="model" checked={checked} data-autofocus={(checked || (!draft.modelIds.length && index === 0)) ? 'true' : undefined}
                    onChange={event => comparing ? toggle(model.id, event.target.checked) : onDraft({ ...draft, modelIds: [model.id] })}
                  />
                  <span className="picker-name">{modelName(model.id)}</span>
                  <span className={`picker-state ${state(model.id)}`}>{t(`model.${readiness ? state(model.id) : 'checking'}`)}</span>
                </label>
              );
            })}
          </fieldset>
          <div className="picker-foot">
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

export function SizePicker({ draft, multiple, onDraft }: { draft: Draft; multiple: number; onDraft: (draft: Draft) => void }) {
  const { t, number } = useI18n();
  const set = (width: number, height: number) => onDraft({ ...draft, width, height });
  const snap = (value: number) => Math.max(multiple, Math.round(value / multiple) * multiple);
  const preset = PRESETS.find(item => item.width === draft.width && item.height === draft.height);
  return (
    <Popover label={t('composer.size')} trigger={<><ShapeIcon width={draft.width} height={draft.height} size={16} /><span className="chip-text">{t('conversation.size', { width: String(draft.width), height: String(draft.height) })}</span></>}>
      {() => (
        <div className="picker size-picker">
          <div className="segmented" role="radiogroup" aria-label={t('composer.size')}>
            {PRESETS.map(item => (
              <label key={item.key} className={preset?.key === item.key ? 'on' : undefined}>
                <input type="radio" name="size-preset" checked={preset?.key === item.key} data-autofocus={preset?.key === item.key ? 'true' : undefined} onChange={() => set(item.width, item.height)} />
                <ShapeIcon width={item.width} height={item.height} size={16} /><span>{t(`composer.${item.key}`)}</span>
              </label>
            ))}
          </div>
          <div className="size-fields">
            <label className="field compact"><span className="field-label">{t('ui.width')}</span>
              <input type="number" min={multiple} step={multiple} value={draft.width} onChange={event => { const value = Number(event.target.value); if (value > 0) set(value, draft.height); }} onBlur={() => set(snap(draft.width), draft.height)} />
            </label>
            <label className="field compact"><span className="field-label">{t('ui.height')}</span>
              <input type="number" min={multiple} step={multiple} value={draft.height} onChange={event => { const value = Number(event.target.value); if (value > 0) set(draft.width, value); }} onBlur={() => set(draft.width, snap(draft.height))} />
            </label>
          </div>
          <p className="field-help">{t('composer.sizeRule', { multiple })}</p>
        </div>
      )}
    </Popover>
  );
}
