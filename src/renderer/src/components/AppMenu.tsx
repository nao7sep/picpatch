// The in-window menu in the order every app of the fleet uses, so it reads alike everywhere: the app's own actions,
// Settings and the setup that belongs with it, Records, Zoom, then Shortcuts and About.
import { shortcuts, shortcutText, type ShortcutId } from '../../../shared/shortcuts.ts';
import { useI18n } from '../i18n.tsx';
import { Menu, type MenuEntry } from './Menu.tsx';
import { MenuIcon } from './icons.tsx';

const mac = /Mac/.test(navigator.platform);
const keys = (id: ShortcutId) => shortcutText(shortcuts.find(entry => entry.id === id)!, mac);

export function AppMenu({ onCommand }: { onCommand: (command: string) => void }) {
  const { t } = useI18n();
  const entries: MenuEntry[] = [
    { id: 'new', label: t('ui.new_session'), keys: keys('new') },
    { id: 'collection', label: t('ui.open_collection') },
    'separator',
    { id: 'settingsButton', label: t('ui.settings'), keys: keys('settingsButton') },
    { id: 'manage', label: t('ui.managed_tools_and_models') },
    { id: 'setup', label: t('model.fix') },
    'separator',
    { id: 'showRecords', label: t('ui.records') },
    'separator',
    { id: 'uiZoomIn', label: t('native.zoomIn'), keys: keys('uiZoomIn') },
    { id: 'uiZoomOut', label: t('native.zoomOut'), keys: keys('uiZoomOut') },
    { id: 'uiZoomReset', label: t('native.resetZoom'), keys: keys('uiZoomReset') },
    'separator',
    { id: 'shortcutsButton', label: t('shortcuts.title'), keys: keys('shortcutsButton') },
    { id: 'about', label: t('ui.about_picpatch') },
  ];
  return <Menu label={t('menu.open')} trigger={<MenuIcon />} entries={entries} onChoose={onCommand} />;
}
