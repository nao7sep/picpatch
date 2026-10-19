// Image options for the next command, beside the transcript: seed and count, the
// model's own sampling controls, the edit region and canvas expansion when an image
// is being edited, and a structural control map. Only what the chosen model offers
// is shown; a value the model cannot use stays visible so it can be cleared.
import type { Draft, Session } from '../../../shared/session.ts';
import type { ModelCapabilities, SamplingParameters } from 'picpatchsdk/types';
import type { CatalogModel } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { BrushIcon, CloseIcon } from './icons.tsx';

const PARAMETERS = ['steps', 'guidance', 'strength', 'identityStyleStrength', 'appearanceStrength', 'sampler', 'scheduler', 'negativePrompt'] as const;
type ParameterKey = typeof PARAMETERS[number];
const CONTROL_KINDS = ['canny', 'depth', 'pose'] as const;

export interface OptionsPaneProps {
  session: Session;
  draft: Draft;
  models: readonly CatalogModel[];
  samples: number;
  onSamples: (samples: number) => void;
  onDraft: (draft: Draft, save: 'later' | 'now') => void;
  onPaintMask: () => void;
  onChooseControl: (kind: NonNullable<Draft['control']>['kind']) => void;
  onClose: () => void;
}

export function OptionsPane({ session, draft, models, samples, onSamples, onDraft, onPaintMask, onChooseControl, onClose }: OptionsPaneProps) {
  const { t, term, number } = useI18n();
  const caps: ModelCapabilities | undefined = models.find(model => model.id === draft.modelIds[0])?.capabilities;
  const descriptors = (caps?.parameters ?? {}) as Record<string, { default?: unknown; minimum?: number; maximum?: number; integer?: boolean; values?: string[] } | undefined>;
  const parameters = draft.parameters as Record<string, unknown>;
  const setParameter = (key: ParameterKey, value: string | number | undefined, save: 'later' | 'now' = 'later') => {
    const next = { ...draft.parameters } as Record<string, unknown>;
    if (value === undefined || value === '') delete next[key]; else next[key] = value;
    onDraft({ ...draft, parameters: next as SamplingParameters }, save);
  };
  const shown = PARAMETERS.filter(key => descriptors[key] || parameters[key] !== undefined);
  const editing = Boolean(draft.source);
  const control = draft.control;
  const controlName = control ? session.assets.find(asset => asset.id === control.image)?.name ?? t('ui.control_image') : undefined;
  const maskNote = caps?.maskMode === 'composite' || caps?.maskMode === 'latent-composite' ? t('ui.masked_edits_preserve_normalized_pixels_outside_the_edited_region')
    : caps?.maskMode === 'native' ? t('ui.native_inpainting_pixels_outside_the_mask_may_change') : t('ui.this_model_does_not_support_masks');

  return (
    <aside className="options-pane" aria-label={t('conversation.options')}>
      <header className="pane-head">
        <h2>{t('conversation.options')}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('ui.close')} title={t('ui.close')}><CloseIcon /></button>
      </header>
      <div className="pane-body">
        <section className="pane-section">
          <div className="field-pair">
            <label className="field compact">
              <span className="field-label">{t('ui.seed')}</span>
              <input type="number" min={0} step={1} value={draft.seed ?? ''} placeholder={t('ui.random')}
                onChange={event => { const next = { ...draft }; if (event.target.value === '') delete next.seed; else next.seed = Math.max(0, Math.trunc(Number(event.target.value))); onDraft(next, 'later'); }} />
            </label>
            <label className="field compact">
              <span className="field-label">{t('ui.samples')}</span>
              <input type="number" min={1} max={100} step={1} value={samples} onChange={event => onSamples(Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)) || 1)))} />
            </label>
          </div>
          <p className="field-help">{t('options.samplesHelp')}</p>
        </section>

        {shown.length > 0 && (
          <section className="pane-section">
            <h3 className="group-label">{t('ui.advanced_settings')}</h3>
            {shown.map(key => {
              const descriptor = descriptors[key];
              const value = parameters[key];
              const label = descriptor ? term('parameter', key) : t('parameter.unsupported', { name: term('parameter', key) });
              if (key === 'negativePrompt') return (
                <label key={key} className="field compact">
                  <span className="field-label">{label}</span>
                  <textarea rows={3} value={typeof value === 'string' ? value : ''} onChange={event => setParameter(key, event.target.value)} />
                </label>
              );
              if (descriptor?.values) return (
                <label key={key} className="field compact">
                  <span className="field-label">{label}</span>
                  <select value={typeof value === 'string' ? value : ''} onChange={event => setParameter(key, event.target.value, 'now')}>
                    <option value="">{t('parameter.default', { value: String(descriptor.default ?? '') })}</option>
                    {descriptor.values.map(item => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              );
              return (
                <label key={key} className="field compact">
                  <span className="field-label">{label}</span>
                  <input type="number" step={descriptor?.integer ? 1 : 'any'} min={descriptor?.minimum} max={descriptor?.maximum}
                    value={typeof value === 'number' ? value : ''}
                    placeholder={typeof descriptor?.default === 'number' ? number(descriptor.default) : t('ui.default')}
                    onChange={event => setParameter(key, event.target.value === '' ? undefined : Number(event.target.value))} />
                </label>
              );
            })}
          </section>
        )}

        {editing && (
          <section className="pane-section">
            <h3 className="group-label">{t('options.editRegion')}</h3>
            <p className="field-help">{maskNote}</p>
            <div className="button-row">
              <button type="button" className="button compact" disabled={caps?.maskMode === 'none'} onClick={onPaintMask}><BrushIcon /><span>{draft.mask ? t('options.editMask') : t('ui.paint_mask')}</span></button>
              {draft.mask && <button type="button" className="button compact" onClick={() => { const next = { ...draft }; delete next.mask; onDraft(next, 'now'); }}>{t('ui.clear_mask')}</button>}
            </div>
            <label className="check">
              <input type="checkbox" checked={Boolean(draft.outpaint)} disabled={!caps?.outpainting && !draft.outpaint}
                onChange={event => { const next = { ...draft }; if (event.target.checked) next.outpaint = { width: draft.width + 256, height: draft.height + 256, left: 128, top: 128 }; else delete next.outpaint; onDraft(next, 'now'); }} />
              <span>{t('ui.expand_canvas')}</span>
            </label>
            {draft.outpaint && (
              <div className="field-grid">
                {(['width', 'height', 'left', 'top'] as const).map(key => (
                  <label key={key} className="field compact">
                    <span className="field-label">{t(key === 'width' ? 'ui.width' : key === 'height' ? 'ui.height' : key === 'left' ? 'ui.source_left' : 'ui.source_top')}</span>
                    <input type="number" min={key === 'left' || key === 'top' ? 0 : 1} value={draft.outpaint![key]}
                      onChange={event => onDraft({ ...draft, outpaint: { ...draft.outpaint!, [key]: Math.max(0, Math.trunc(Number(event.target.value))) } }, 'later')} />
                  </label>
                ))}
              </div>
            )}
          </section>
        )}

        {(caps?.controlKinds?.length || control) ? (
          <section className="pane-section">
            <h3 className="group-label">{t('ui.structural_conditioning')}</h3>
            <p className="field-help">{t('ui.supply_a_prepared_control_map')}</p>
            <label className="field compact">
              <span className="field-label">{t('ui.control_kind')}</span>
              <select value={control?.kind ?? caps?.controlKinds?.[0] ?? 'canny'} onChange={event => {
                const kind = event.target.value as NonNullable<Draft['control']>['kind'];
                if (control) onDraft({ ...draft, control: { ...control, kind } }, 'now'); else onChooseControl(kind);
              }}>
                {CONTROL_KINDS.map(kind => <option key={kind} value={kind} disabled={!caps?.controlKinds?.includes(kind) && control?.kind !== kind}>{t(`control.${kind}`)}</option>)}
              </select>
            </label>
            {control ? (
              <div className="path-row">
                <span className="path-value" title={controlName}>{controlName}</span>
                <button type="button" className="button compact" onClick={() => { const next = { ...draft }; delete next.control; onDraft(next, 'now'); }}>{t('ui.clear_map')}</button>
              </div>
            ) : (
              <button type="button" className="button compact" disabled={!caps?.controlKinds?.length} onClick={() => onChooseControl(caps?.controlKinds?.[0] ?? 'canny')}>{t('ui.add_control_map')}</button>
            )}
            {control && (
              <label className="field compact">
                <span className="field-label">{t('ui.control_strength')}</span>
                <input type="number" step="any" value={control.strength ?? ''} placeholder={t('ui.model_default')}
                  onChange={event => { const next = { ...control }; if (event.target.value === '') delete next.strength; else next.strength = Number(event.target.value); onDraft({ ...draft, control: next }, 'later'); }} />
              </label>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
