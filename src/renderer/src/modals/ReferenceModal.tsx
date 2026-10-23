// One reference group: its name, what it shows, how the model should use it, and its
// photos. Edits apply to the draft as they are made, which saves itself, so there is
// nothing to discard.
import type { ReferenceDraft, Session } from '../../../shared/session.ts';
import { imageUrl, type CatalogModel } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { CloseIcon, PlusIcon } from '../components/icons.tsx';
import { Modal } from './Modal.tsx';

const ROLES = ['subject', 'object', 'style', 'background'] as const;
const CONDITIONING = ['prompt', 'identity', 'appearance'] as const;
const CLASSES = ['man', 'woman', 'girl', 'boy'] as const;

export function ReferenceModal({ session, group, models, errors = [], onChange, onAddPhotos, onRemove, onClose }: {
  session: Session; group: ReferenceDraft; models: readonly CatalogModel[]; errors?: unknown[];
  onChange: (group: ReferenceDraft, save: 'later' | 'now') => void; onAddPhotos: () => void; onRemove: () => void; onClose: () => void;
}) {
  const { t, errorText } = useI18n();
  const conditioning = new Set(models.map(model => model.capabilities.referenceConditioning));
  const independent = conditioning.has('independent-subject');
  // The class word only matters to identity conditioning; an authored value stays visible to clear.
  const classNeeded = Boolean(group.className) || (group.conditioning === 'identity' && !independent);
  return (
    <Modal title={t('reference.title')} width={520} onClose={onClose} footer={<>
      <button type="button" className="button outline-danger" onClick={onRemove}>{t('ui.remove_group')}</button>
      <span className="spacer" />
      <button type="button" className="button primary" onClick={onClose}>{t('ui.done')}</button>
    </>}>
      {errors.map((error, index) => <p key={index} className="notice notice-error" role="alert">{errorText(error)}</p>)}
      {independent && <p className="field-help">{t('admission.independent', { reference: group.id })}</p>}
      <label className="field">
        <span className="field-label">{t('ui.reference_group_name')}</span>
        <input type="text" data-autofocus="true" value={group.id} onChange={event => onChange({ ...group, id: event.target.value }, 'later')} />
      </label>
      <div className="field-row">
        <label className="field compact">
          <span className="field-label">{t('ui.reference_role')}</span>
          <select value={group.role} onChange={event => onChange({ ...group, role: event.target.value as ReferenceDraft['role'] }, 'now')}>
            {ROLES.map(role => <option key={role} value={role}>{t(`role.${role}`)}</option>)}
          </select>
        </label>
        <label className="field compact">
          <span className="field-label">{t('ui.conditioning')}</span>
          <select value={group.conditioning ?? 'prompt'} onChange={event => onChange({ ...group, conditioning: event.target.value as ReferenceDraft['conditioning'] }, 'now')}>
            {CONDITIONING.map(value => <option key={value} value={value}>{t(`conditioning.${value}`)}</option>)}
          </select>
        </label>
        {classNeeded && (
          <label className="field compact">
            <span className="field-label">{t('ui.identity_class')}</span>
            <select value={group.className ?? ''} onChange={event => { const next = { ...group }; if (event.target.value) next.className = event.target.value as ReferenceDraft['className']; else delete next.className; onChange(next, 'now'); }}>
              <option value="">{t('ui.not_selected')}</option>
              {CLASSES.map(value => <option key={value} value={value}>{t(`class.${value}`)}</option>)}
            </select>
          </label>
        )}
      </div>
      <h3 className="group-label">{t('reference.photos')}</h3>
      <ul className="photo-grid">
        {group.images.map(key => (
          <li key={key} className="photo">
            <img src={imageUrl(session.id, key, true)} alt={session.assets.find(asset => asset.id === key)?.name ?? ''} draggable={false} />
            <button type="button" className="chip-remove" aria-label={t('ui.remove_photo')} title={t('ui.remove_photo')} onClick={() => onChange({ ...group, images: group.images.filter(item => item !== key) }, 'now')}><CloseIcon /></button>
          </li>
        ))}
        <li><button type="button" className="photo-add" onClick={onAddPhotos}><PlusIcon /><span>{t('ui.add_photos')}</span></button></li>
      </ul>
    </Modal>
  );
}
