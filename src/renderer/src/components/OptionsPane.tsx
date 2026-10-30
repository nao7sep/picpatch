// Image options for the next command, beside the transcript: seed and count, the
// model's own sampling controls, the edit region and canvas expansion when an image
// is being edited, and a structural control map. Only what the chosen model offers
// is shown; a value the model cannot use stays visible so it can be cleared.
import { canPaintMask, maskNote } from '../../../shared/image-command.ts';
import { controlKinds, type Draft, type Session } from '../../../shared/session.ts';
import type { ModelCapabilities, SamplingParameters } from 'picpatchsdk/types';
import { useEffect, useState } from 'react';
import { imageUrl, type CatalogModel } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { checkNumber, NumberField, useFieldEdits } from '../number-field.tsx';
import { BrushIcon, CloseIcon } from './icons.tsx';

const PARAMETERS = ['steps', 'guidance', 'strength', 'identityStyleStrength', 'appearanceStrength', 'sampler', 'scheduler', 'negativePrompt'] as const;
type ParameterKey = typeof PARAMETERS[number];
const CANVAS = ['width', 'height', 'left', 'top'] as const;
type CanvasKey = typeof CANVAS[number];

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

/** The highest seed a run can use. */
export const SEED_MAX = 2 ** 32 - 1;

/** The displayed (oriented) size of the image being edited, once it has loaded. */
function useImageSize(url: string | undefined) {
  const [size, setSize] = useState<{ url: string; width: number; height: number }>();
  useEffect(() => {
    if (!url) return;
    const image = new Image();
    image.onload = () => setSize({ url, width: image.naturalWidth, height: image.naturalHeight });
    image.src = url;
    return () => { image.onload = null; };
  }, [url]);
  return size?.url === url ? size : undefined;
}

export function OptionsPane({ session, draft, models, samples, onSamples, onDraft, onPaintMask, onChooseControl, onClose }: OptionsPaneProps) {
  const { t, term, number } = useI18n();
  const caps: ModelCapabilities | undefined = models.find(model => model.id === draft.modelIds[0])?.capabilities;
  const descriptors = (caps?.parameters ?? {}) as Record<string, { default?: unknown; minimum?: number; maximum?: number; integer?: boolean; values?: string[] } | undefined>;
  const parameters = draft.parameters as Record<string, unknown>;
  const setParameter = (key: ParameterKey, value: string | number | undefined, save: 'later' | 'now' = 'later') => {
    const next = { ...draft.parameters } as Record<string, unknown>;
    if (value === undefined || (value === '' && key !== 'negativePrompt')) delete next[key]; else next[key] = value;
    onDraft({ ...draft, parameters: next as SamplingParameters }, save);
  };
  const activateNegativePrompt = () => {
    const descriptor = caps?.parameters?.negativePrompt;
    const guidance = draft.parameters.guidance ?? caps?.parameters?.guidance?.default;
    // An active blank field is an explicit empty prompt; Reset keeps omission distinct.
    if (draft.parameters.negativePrompt === undefined && descriptor?.requiredForGuidanceAbove !== undefined && guidance !== undefined && guidance > descriptor.requiredForGuidanceAbove) setParameter('negativePrompt', '');
  };
  const shown = PARAMETERS.filter(key => descriptors[key] || parameters[key] !== undefined);
  const editing = Boolean(draft.source);
  const control = draft.control;
  const controlName = control ? session.assets.find(asset => asset.id === control.image)?.name ?? t('ui.control_image') : undefined;
  const source = useImageSize(editing && draft.outpaint ? imageUrl(session.id, draft.source!) : undefined);
  // The canvas holds the image at its offset: each side's size bounds the offset, and the offset bounds the size.
  const outpaintRule = (key: CanvasKey, canvas = draft.outpaint!) => {
    const along = key === 'width' || key === 'left' ? 'width' : 'height', offset = along === 'width' ? canvas.left : canvas.top;
    if (key === along) return { whole: true, min: source ? source[along] + offset : 1 };
    return { whole: true, min: 0, ...(source ? { max: canvas[along] - source[along] } : {}) };
  };
  // The four canvas values bound each other, so a value one of them refused is checked again, with the others,
  // whenever another changes or the image's size becomes known: it commits once it fits, and its reason follows the new bounds.
  const fields = useFieldEdits();
  const canvas = draft.outpaint;
  useEffect(() => {
    if (!canvas) return;
    let next = canvas;
    for (const key of CANVAS) {
      const id = `outpaint.${key}`, entry = fields.edits[id];
      if (!entry?.error) continue;
      const checked = checkNumber(entry.text, outpaintRule(key, next));
      if ('error' in checked) { if (JSON.stringify(checked.error) !== JSON.stringify(entry.error)) fields.edit(id, { ...entry, error: checked.error }); continue; }
      fields.edit(id, { text: entry.text, label: entry.label, value: checked.value! });
      next = { ...next, [key]: checked.value! };
    }
    if (next !== canvas) onDraft({ ...draft, outpaint: next }, 'later');
  }, [canvas?.width, canvas?.height, canvas?.left, canvas?.top, source?.width, source?.height]);

  return (
    <aside className="options-pane" aria-label={t('conversation.options')}>
      <header className="pane-head">
        <h2>{t('conversation.options')}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('ui.close')} title={t('ui.close')}><CloseIcon /></button>
      </header>
      <div className="pane-body">
        <section className="pane-section">
          <div className="field-pair">
            <NumberField id="seed" label={t('ui.seed')} value={draft.seed} rule={{ whole: true, min: 0, max: SEED_MAX, empty: true }} placeholder={t('ui.random')}
              onCommit={seed => { const next = { ...draft }; if (seed === undefined) delete next.seed; else next.seed = seed; onDraft(next, 'later'); }} />
            <NumberField id="samples" label={t('ui.samples')} value={samples} rule={{ whole: true, min: 1, max: 100 }} onCommit={value => onSamples(value!)} />
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
                <div key={key} className="field compact">
                  <span className="field-label">{label}</span>
                  <textarea aria-label={label} rows={3} onFocus={activateNegativePrompt} value={typeof value === 'string' ? value : ''} onChange={event => setParameter(key, event.target.value)} />
                  {value !== undefined && <button type="button" className="quiet-button" onClick={() => setParameter(key, undefined, 'now')}>{t('ui.default')}</button>}
                </div>
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
                <NumberField key={key} id={`parameter.${key}`} label={label} value={typeof value === 'number' ? value : undefined}
                  rule={{ ...(descriptor?.integer ? { whole: true } : {}), ...(descriptor?.minimum !== undefined ? { min: descriptor.minimum } : {}), ...(descriptor?.maximum !== undefined ? { max: descriptor.maximum } : {}), empty: true }}
                  placeholder={typeof descriptor?.default === 'number' ? number(descriptor.default) : t('ui.default')}
                  onCommit={next => setParameter(key, next)} />
              );
            })}
          </section>
        )}

        {editing && (
          <section className="pane-section">
            <h3 className="group-label">{t('options.editRegion')}</h3>
            <p className="field-help">{t(maskNote(caps?.maskMode))}</p>
            <div className="button-row">
              <button type="button" className="button compact" disabled={!canPaintMask(session, draft, caps?.maskMode)} onClick={onPaintMask}><BrushIcon /><span>{draft.mask ? t('options.editMask') : t('ui.paint_mask')}</span></button>
              {draft.mask && <button type="button" className="button compact" onClick={() => { const next = { ...draft }; delete next.mask; onDraft(next, 'now'); }}>{t('ui.clear_mask')}</button>}
            </div>
            <label className="check">
              <input type="checkbox" checked={Boolean(draft.outpaint)} disabled={!caps?.outpainting && !draft.outpaint}
                onChange={event => { const next = { ...draft }; if (event.target.checked) next.outpaint = { width: draft.width + 256, height: draft.height + 256, left: 128, top: 128 }; else delete next.outpaint; onDraft(next, 'now'); }} />
              <span>{t('ui.expand_canvas')}</span>
            </label>
            {draft.outpaint && (
              <div className="field-grid">
                {CANVAS.map(key => (
                  <NumberField key={key} id={`outpaint.${key}`} label={t(key === 'width' ? 'ui.width' : key === 'height' ? 'ui.height' : key === 'left' ? 'ui.source_left' : 'ui.source_top')}
                    value={draft.outpaint![key]} rule={outpaintRule(key)} onCommit={next => onDraft({ ...draft, outpaint: { ...draft.outpaint!, [key]: next! } }, 'later')} />
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
                {controlKinds.map(kind => <option key={kind} value={kind} disabled={!caps?.controlKinds?.includes(kind) && control?.kind !== kind}>{t(`control.${kind}`)}</option>)}
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
              <NumberField id="control.strength" label={t('ui.control_strength')} value={control.strength} rule={{ min: 0, empty: true }} placeholder={t('ui.model_default')}
                onCommit={strength => { const next = { ...control }; if (strength === undefined) delete next.strength; else next.strength = strength; onDraft({ ...draft, control: next }, 'later'); }} />
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
