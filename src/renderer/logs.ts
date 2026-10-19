import { renderCollection } from './collection.ts';
import { localize } from './localization.ts';
import { activeLocale, t } from '../shared/i18n/index.ts';
import { defaultFont, fixedFont } from '../shared/appearance.ts';
import type { LogsBridge } from '../shared/logs-bridge.ts';
import type { RecordSummary, RecordsQuery, RecordsPage } from '../shared/records.ts';
declare global { interface Window { picpatchLogs: LogsBridge } }
export function logsView(api: LogsBridge) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const list = element<HTMLDivElement>('logsList'); const detail = element<HTMLPreElement>('logsDetail');
  const issue = element<HTMLParagraphElement>('logsIssue'); const status = element<HTMLParagraphElement>('logsStatus');
  const older = element<HTMLButtonElement>('older');
  let appearanceRevision = 0;
  let page: RecordsPage = { records: [], more: false }; let queryRevision = 0; let detailRevision = 0;
  let selected: number | undefined; let query: RecordsQuery = { current: true, level: 'all', search: '' };
  let pending = false; let loadFailed = false; let changed = false; let stopped = false; let detailText: string | undefined;
  function fail() { issue.hidden = false; issue.textContent = t('logs.failed'); }
  function state() { status.textContent = pending ? t('logs.loading') : changed ? t('logs.newRecords') : loadFailed || page.records.length ? '' : t('logs.empty'); older.disabled = pending || !page.more; }
  async function choose(record: RecordSummary) {
    selected = record.id; const revision = ++detailRevision; detailText = undefined; detail.textContent = t('logs.loading');

    try { const text = await api.detail(record.id); if (stopped || revision !== detailRevision) return; detailText = text ?? undefined; detail.textContent = text ?? t('logs.empty'); }
    catch { if (!stopped && revision === detailRevision) { detail.textContent = ''; fail(); } }
  }
  function render() {
    const items = [];
    const formatter = new Intl.DateTimeFormat(activeLocale().format, { dateStyle: 'medium', timeStyle: 'medium' });
    for (const record of page.records) {
      const row = document.createElement('button'); row.type = 'button'; row.role = 'option'; row.dataset.id = String(record.id); row.tabIndex = record.id === selected || (selected === undefined && record === page.records[0]) ? 0 : -1; row.setAttribute('aria-selected', String(record.id === selected));
      const time = document.createElement('time'); time.dateTime = record.time; const instant = new Date(record.time); time.textContent = Number.isNaN(instant.valueOf()) ? record.time : formatter.format(instant);
      const level = document.createElement('span'); level.textContent = record.level;
      const message = document.createElement('span'); message.className = 'recordMessage'; message.textContent = record.message;
      row.append(time, level, message); items.push({ key: String(record.id), label: record.message, element: row });
    }
    renderCollection(list, items, { label: t('ui.logs'), selected: selected === undefined ? [] : [String(selected)], empty: pending ? t('logs.loading') : loadFailed ? t('logs.failed') : t('logs.empty'), select: keys => { const record = page.records.find(row => String(row.id) === keys[0]); if (record) void choose(record); } });
  }
  async function load(before?: number) {
    const revision = ++queryRevision; ++detailRevision; pending = true; loadFailed = false; changed = false; selected = undefined; detailText = undefined; detail.textContent = t('logs.select'); issue.hidden = true;
    query = { current: element<HTMLSelectElement>('launch').value === 'current', level: element<HTMLSelectElement>('level').value as RecordsQuery['level'], search: element<HTMLInputElement>('search').value, ...(before === undefined ? {} : { before }) };
    page = { records: [], more: false }; render(); state();
    try { const result = await api.query(query); if (stopped || revision !== queryRevision) return; page = result; render(); }
    catch { if (!stopped && revision === queryRevision) { page = { records: [], more: false }; loadFailed = true; render(); fail(); } }
    finally { if (!stopped && revision === queryRevision) { pending = false; render(); state(); } }
  }
  element<HTMLFormElement>('searchForm').onsubmit = event => { event.preventDefault(); void load(); };
  element<HTMLSelectElement>('launch').onchange = () => void load(); element<HTMLSelectElement>('level').onchange = () => void load();
  older.onclick = () => void load(page.records.at(-1)?.id); element<HTMLButtonElement>('newest').onclick = () => void load();
  async function appearance() {
    const revision = ++appearanceRevision;
    try {
      const view = await api.appearance(); if (stopped || revision !== appearanceRevision) return;
      await localize(view.locale); if (stopped || revision !== appearanceRevision) return;
      document.title = t('ui.logs'); document.documentElement.style.colorScheme = view.dark ? 'dark' : 'light'; document.documentElement.style.setProperty('--font-ui', view.uiFont || defaultFont); document.documentElement.style.setProperty('--font-mono', fixedFont);
      render(); state(); if (!issue.hidden) issue.textContent = t('logs.failed'); if (detailText === undefined) detail.textContent = t('logs.select');
    } catch { if (!stopped && revision === appearanceRevision) { document.body.hidden = false; fail(); } }
  }
  const unsubscribe = api.onRecordsChanged(() => { changed = true; state(); });
  const unappearance = api.onAppearanceChanged(() => { void appearance(); });
  const keydown = (event: KeyboardEvent) => { if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); void api.close().catch(fail); } };
  window.addEventListener('keydown', keydown);
  void appearance().then(() => load());
  return () => { stopped = true; unsubscribe(); unappearance(); window.removeEventListener('keydown', keydown); };
}
