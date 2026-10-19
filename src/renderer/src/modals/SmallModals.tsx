// The small surfaces: About, Keyboard shortcuts, Rename and Save image. Each is the
// shared shell with its own body.
import { useEffect, useState } from 'react';
import { about } from '../../../shared/about.ts';
import { shortcuts, shortcutText } from '../../../shared/shortcuts.ts';
import { api, imageUrl } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';
import { ExternalIcon } from '../components/icons.tsx';
import iconUrl from '../../../../build/icon.png';
import { Modal } from './Modal.tsx';

const mac = /Mac/.test(navigator.platform);

export function AboutModal({ onClose }: { onClose: () => void }) {
  const { t, errorText } = useI18n();
  const [failure, setFailure] = useState<string>();
  const open = (destination: 'repository' | 'issues') => { setFailure(undefined); void api.openProjectLink(destination).catch(error => setFailure(errorText(error))); };
  return (
    <Modal title={t('ui.about_picpatch')} hideTitle width={380} onClose={onClose} footer={<button type="button" className="button" onClick={onClose}>{t('ui.close')}</button>}>
      <div className="about">
        <img className="about-icon" src={iconUrl} alt="" width={84} height={84} draggable={false} />
        <p className="about-name">{about.name}</p>
        <p className="about-version">{t('about.version', { version: about.version })}</p>
        <p>{t('about.introduction')}</p>
        <p className="about-links">
          <button type="button" className="link-button" onClick={() => open('repository')}>{t('about.repository')}<ExternalIcon /></button>
          <button type="button" className="link-button" onClick={() => open('issues')}>{t('about.issues')}<ExternalIcon /></button>
        </p>
        <p className="about-meta">{about.copyright}</p>
        <p className="about-meta">{t('about.license', { license: about.license })}</p>
        {failure && <p className="field-error" role="alert">{failure}</p>}
      </div>
    </Modal>
  );
}

const LOCAL_KEYS = [
  ['shortcuts.send', 'Enter'], ['shortcuts.newline', 'Shift+Enter'], ['shortcuts.rename', 'F2'], ['shortcuts.delete', mac ? 'Delete / Cmd+Backspace' : 'Delete'],
  ['shortcuts.viewerNavigate', 'Left/Right'], ['shortcuts.maskUndo', `${mac ? 'Cmd' : 'Ctrl'}+Z`], ['shortcuts.maskRedo', `${mac ? 'Cmd' : 'Ctrl'}+Shift+Z`],
] as const;

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const row = (label: string, keys: string) => (
    <div key={label} className="shortcut-row"><dt>{label}</dt><dd><span className="keys">{keys.split(' / ').map(chord => <kbd key={chord}>{chord}</kbd>)}</span></dd></div>
  );
  return (
    <Modal title={t('shortcuts.title')} width={480} onClose={onClose} footer={<button type="button" className="button" onClick={onClose}>{t('ui.close')}</button>}>
      <h3 className="group-label">{t('shortcuts.workspace')}</h3>
      <dl className="shortcut-list">{shortcuts.filter(entry => entry.id !== 'quit').map(entry => row(t(entry.label), shortcutText(entry, mac)))}</dl>
      <h3 className="group-label">{t('shortcuts.inContext')}</h3>
      <dl className="shortcut-list">{LOCAL_KEYS.map(([label, keys]) => row(t(label), keys))}</dl>
      <p className="field-help">{t(mac ? 'shortcuts.modifiers' : 'shortcuts.modifiersOther')}</p>
    </Modal>
  );
}

export function RenameModal({ name, onClose, onRename, onDirty, confirmDiscard }: { name: string; onClose: () => void; onRename: (name: string) => Promise<string | undefined>; onDirty: (dirty: boolean) => void; confirmDiscard: () => Promise<boolean> }) {
  const { t } = useI18n();
  const [value, setValue] = useState(name);
  const [failure, setFailure] = useState<string>();
  const [working, setWorking] = useState(false);
  const valid = value.trim() !== '';
  const dirty = value !== name;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const close = async () => { if (!dirty || await confirmDiscard()) onClose(); };
  const submit = async () => {
    if (!valid || working) return;
    if (value.trim() === name) { onClose(); return; }
    setWorking(true); setFailure(await onRename(value.trim())); setWorking(false);
  };
  return (
    <Modal title={t('ui.rename_session')} width={420} onClose={() => void close()} guarded={dirty} footer={<>
      <button type="button" className="button" onClick={() => void close()}>{t('ui.cancel')}</button>
      <button type="button" className="button primary" disabled={!valid || working} onClick={() => void submit()}>{t('ui.rename')}</button>
    </>}>
      <label className="field">
        <span className="field-label">{t('ui.session_name')}</span>
        <input data-autofocus="true" type="text" value={value} onFocus={event => event.currentTarget.select()} onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !isComposing(event.nativeEvent)) { event.preventDefault(); void submit(); } }} />
      </label>
      {!valid && <p className="field-error">{t('ui.enter_a_session_name')}</p>}
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </Modal>
  );
}

/** Save image: the settings file is opt-in each time, and prompts in it are opt-in again. */
export function ExportModal({ sessionId, runId, label, initialSidecar, onClose, onSave }: {
  sessionId: string; runId: string; label: string; initialSidecar: boolean; onClose: () => void;
  onSave: (sidecar: boolean, includeInputs: boolean) => Promise<string | undefined>;
}) {
  const { t } = useI18n();
  const [sidecar, setSidecar] = useState(initialSidecar);
  const [prompts, setPrompts] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [working, setWorking] = useState(false);
  const save = async () => { setWorking(true); setFailure(undefined); setFailure(await onSave(sidecar, sidecar && prompts)); setWorking(false); };
  return (
    <Modal title={t('ui.save_image')} width={440} onClose={onClose} footer={<>
      <button type="button" className="button" onClick={onClose}>{t('ui.cancel')}</button>
      <button type="button" className="button primary" data-autofocus="true" disabled={working} onClick={() => void save()}>{t('export.choose')}</button>
    </>}>
      <div className="export-head">
        <img className="export-preview" src={imageUrl(sessionId, runId)} alt="" draggable={false} />
        <span className="export-name">{label}</span>
      </div>
      <label className="check"><input type="checkbox" checked={sidecar} onChange={event => setSidecar(event.target.checked)} /><span>{t('export.sidecar')}</span></label>
      <label className={`check nested${sidecar ? '' : ' disabled'}`}><input type="checkbox" disabled={!sidecar} checked={sidecar && prompts} onChange={event => setPrompts(event.target.checked)} /><span>{t('ui.include_prompts')}</span></label>
      <p className="field-help">{t('export.privacy')}</p>
      {failure && <p className="field-error" role="alert">{failure}</p>}
    </Modal>
  );
}
