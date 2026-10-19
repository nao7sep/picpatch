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
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = false; let loadFailed = false; let changed = false; let stopped = false; let detailText: string | undefined;
  function fail() { issue.hidden = false; issue.textContent = t('logs.failed'); }
  function state() { status.textContent = pending ? t('logs.loading') : changed ? t('logs.newRecords') : loadFailed || page.records.length ? '' : t('logs.empty'); older.disabled = pending || !page.more; }
  function detailFields(text: string | undefined) {
    const fields = element<HTMLDListElement>('recordFields'); fields.replaceChildren();
    if (!text) return;
    try {
      const record = JSON.parse(text), event = record.event ?? {};
      const values = { time: event.time, action: event.action ?? event.verb ?? event.type, session: record.session, model: event.modelId ?? event.model, message: event.message };
      for (const [key, value] of Object.entries(values)) if (typeof value === 'string') {
        const label = document.createElement('dt'); label.textContent = t(`logs.${key}`);
        const content = document.createElement('dd'); content.textContent = key === 'time' && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat(activeLocale().format, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : value;
        fields.append(label, content);
      }
    } catch { /* Older diagnostic payloads remain available verbatim below. */ }
  }
  async function choose(record: RecordSummary) {
    selected = record.id; const revision = ++detailRevision; detailText = undefined; detailFields(undefined); detail.textContent = t('logs.loading');

    try { const text = await api.detail(record.id); if (stopped || revision !== detailRevision) return; detailText = text ?? undefined; detailFields(detailText); detail.textContent = text ?? t('logs.empty'); }
    catch { if (!stopped && revision === detailRevision) { detail.textContent = ''; fail(); } }
  }
  function render() {
    const items = [];
    const formatter = new Intl.DateTimeFormat(activeLocale().format, { dateStyle: 'medium', timeStyle: 'medium' });
    for (const record of page.records) {
      const row = document.createElement('button'); row.type = 'button'; row.role = 'option'; row.dataset.id = String(record.id); row.tabIndex = record.id === selected || (selected === undefined && record === page.records[0]) ? 0 : -1; row.setAttribute('aria-selected', String(record.id === selected));
      const time = document.createElement('time'); time.dateTime = record.time; const instant = new Date(record.time); time.textContent = Number.isNaN(instant.valueOf()) ? record.time : formatter.format(instant);
      const level = document.createElement('span'); level.textContent = t(`logs.${record.level}`); level.className = `recordLevel ${record.level}`;
      const message = document.createElement('span'); message.className = 'recordMessage'; message.textContent = record.message;
      row.append(time, level, message); items.push({ key: String(record.id), label: record.message, element: row });
    }
    renderCollection(list, items, { label: t('ui.logs'), selected: selected === undefined ? [] : [String(selected)], empty: pending ? t('logs.loading') : loadFailed ? t('logs.failed') : t('logs.empty'), select: keys => { const record = page.records.find(row => String(row.id) === keys[0]); if (record) void choose(record); } });
  }
  async function load(before?: number) {
    if (before !== undefined && pending) return;
    const revision = ++queryRevision; pending = true; loadFailed = false; changed = false; issue.hidden = true;
    if (before === undefined) {
      ++detailRevision; selected = undefined; detailText = undefined; detailFields(undefined); detail.textContent = t('logs.select');
      query = { current: element<HTMLSelectElement>('launch').value === 'current', level: element<HTMLSelectElement>('level').value as RecordsQuery['level'], search: element<HTMLInputElement>('search').value };
      page = { records: [], more: false }; render();
    }
    state();
    try {
      const result = await api.query({ ...query, ...(before === undefined ? {} : { before }) });
      if (stopped || revision !== queryRevision) return;
      const scroll = list.scrollTop;
      page = { records: before === undefined ? result.records : [...page.records, ...result.records.filter(row => !page.records.some(existing => existing.id === row.id))], more: result.more };
      render(); if (before !== undefined) list.scrollTop = scroll;
    }
    catch { if (!stopped && revision === queryRevision) { loadFailed = true; fail(); } }
    finally { if (!stopped && revision === queryRevision) { pending = false; render(); state(); } }
  }
  function search() { clearTimeout(searchTimer); void load(); }
  element<HTMLFormElement>('searchForm').onsubmit = event => { event.preventDefault(); search(); };
  element<HTMLInputElement>('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 250); };
  element<HTMLSelectElement>('launch').onchange = search; element<HTMLSelectElement>('level').onchange = search;
  older.onclick = () => void load(page.records.at(-1)?.id); element<HTMLButtonElement>('newest').onclick = search;
  list.onscroll = () => { if (!pending && !loadFailed && page.more && list.scrollHeight - list.scrollTop - list.clientHeight < 100) void load(page.records.at(-1)?.id); };
  const splitter = element<HTMLDivElement>('recordsSplitter'), content = element<HTMLDivElement>('logsContent');
  let width = 320, dragging = false, widthLoaded = false;
  let widthWrites = Promise.resolve();
  function paintWidth() {
    const actual = Math.max(320, Math.min(width, content.clientWidth - 445));
    content.style.setProperty('--records-list-width', `${actual}px`); splitter.setAttribute('aria-valuenow', String(Math.round(actual))); splitter.setAttribute('aria-valuemin', '320');
  }
  function saveWidth() { const value = width; widthWrites = widthWrites.catch(() => {}).then(() => api.resizeList(value)); void widthWrites.catch(fail); }
  splitter.onpointerdown = event => { dragging = true; splitter.setPointerCapture(event.pointerId); event.preventDefault(); };
  splitter.onpointermove = event => { if (dragging) { width = Math.max(320, Math.min(event.clientX - content.getBoundingClientRect().left, content.clientWidth - 445)); paintWidth(); } };
  splitter.onpointerup = () => { if (dragging) { dragging = false; saveWidth(); } };
  splitter.onpointercancel = () => { dragging = false; };
  splitter.onkeydown = event => { if (event.isComposing || !['ArrowLeft','ArrowRight','Home'].includes(event.key)) return; event.preventDefault(); width = event.key === 'Home' ? 320 : Math.max(320, Math.min(width + (event.key === 'ArrowRight' ? 20 : -20), content.clientWidth - 445)); paintWidth(); saveWidth(); };
  const sizing = new ResizeObserver(paintWidth); sizing.observe(content);
  async function appearance() {
    const revision = ++appearanceRevision;
    try {
      const view = await api.appearance(); if (stopped || revision !== appearanceRevision) return;
      if (!widthLoaded) { width = view.listWidth ?? 320; widthLoaded = true; paintWidth(); }
      await localize(view.locale); if (stopped || revision !== appearanceRevision) return;
      document.title = t('ui.logs'); document.documentElement.style.colorScheme = view.dark ? 'dark' : 'light'; document.documentElement.style.setProperty('--font-ui', view.uiFont || defaultFont); document.documentElement.style.setProperty('--font-mono', fixedFont);
      render(); state(); detailFields(detailText); if (!issue.hidden) issue.textContent = t('logs.failed'); if (detailText === undefined) detail.textContent = t('logs.select');
    } catch { if (!stopped && revision === appearanceRevision) { document.body.hidden = false; fail(); } }
  }
  const unsubscribe = api.onRecordsChanged(() => { changed = true; state(); });
  const unappearance = api.onAppearanceChanged(() => { void appearance(); });
  const keydown = (event: KeyboardEvent) => { if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); void api.close().catch(fail); } };
  window.addEventListener('keydown', keydown);
  void appearance().then(() => load());
  return () => { stopped = true; sizing.disconnect(); clearTimeout(searchTimer); unsubscribe(); unappearance(); window.removeEventListener('keydown', keydown); };
}
