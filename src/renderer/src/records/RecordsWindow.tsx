// The Records window: the app's diagnostic history, filtered by launch, severity and
// text, newest first, with the selected record's fields and raw detail beside it.
// New records join the top of the list while it is scrolled to the top, keeping the selection; scrolled away, they
// wait until the list returns to the top.
import { useCallback, useEffect, useRef, useState } from 'react';
import { activeLocale, t, useLocale } from '../../../shared/i18n/index.ts';
import type { LogsBridge } from '../../../shared/logs-bridge.ts';
import { recordsPageSize, type RecordSummary, type RecordsQuery } from '../../../shared/records.ts';
import { applyFont } from '../fonts.ts';
import { LanguageRevision } from '../i18n.tsx';
import { isComposing } from '../ime.ts';

declare global { interface Window { picpatchLogs: LogsBridge } }

const LIST_MIN = 320, DETAIL_MIN = 440, SPLITTER_STEP = 16;
const LEVELS = ['all', 'attention', 'error', 'warn', 'info', 'debug'] as const;

export function RecordsWindow({ api }: { api: LogsBridge }) {
  const [revision, setRevision] = useState(-1);
  useEffect(() => {
    let stopped = false;
    const apply = async () => {
      try {
        const view = await api.appearance(); if (stopped) return;
        applyFont(view.uiFont); await useLocale(view.locale);
        document.documentElement.lang = view.locale.language; document.title = t('ui.logs');
        setRevision(value => value + 1);
      } catch { if (!stopped) setRevision(value => Math.max(0, value)); }
    };
    void apply();
    const off = api.onAppearanceChanged(() => { void apply(); });
    return () => { stopped = true; off(); };
  }, [api]);
  if (revision < 0) return null;
  return <LanguageRevision value={revision}><Records api={api} /></LanguageRevision>;
}

function formatTime(value: string) {
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? value : new Intl.DateTimeFormat(activeLocale().format, { dateStyle: 'medium', timeStyle: 'medium' }).format(instant);
}

function Records({ api }: { api: LogsBridge }) {
  const [current, setCurrent] = useState(true);
  const [level, setLevel] = useState<RecordsQuery['level']>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<RecordsQuery>({ current: true, level: 'all', search: '' });
  const [rows, setRows] = useState<RecordSummary[]>([]);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState(false);
  const [selected, setSelected] = useState<number>();
  const [detail, setDetail] = useState<string | null | undefined>();
  const [width, setWidth] = useState<number>(LIST_MIN);
  const [drag, setDrag] = useState<number | null>(null);
  const [keyed, setKeyed] = useState<number | null>(null);
  // listRevision changes only when the list restarts (a filter change), so loading an older page never discards new records.
  const queryRevision = useRef(0), detailRevision = useRef(0), listRevision = useRef(0);
  const list = useRef<HTMLDivElement>(null), shell = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(1100);

  useEffect(() => { void api.appearance().then(view => { if (view.listWidth) setWidth(view.listWidth); }, () => {}); }, [api]);
  useEffect(() => {
    const element = shell.current; if (!element) return;
    const observer = new ResizeObserver(() => setShellWidth(element.clientWidth)); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!isComposing(event) && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); void api.close().catch(() => setFailed(true)); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [api]);

  const load = useCallback(async (next: RecordsQuery, before?: number) => {
    const revision = ++queryRevision.current;
    setPending(true); setFailed(false);
    if (before === undefined) { setChanged(false); ++listRevision.current; ++detailRevision.current; setSelected(undefined); setDetail(undefined); setRows([]); }
    try {
      const page = await api.query({ ...next, ...(before === undefined ? {} : { before }) });
      if (revision !== queryRevision.current) return;
      setRows(existing => before === undefined ? page.records : [...existing, ...page.records.filter(row => !existing.some(item => item.id === row.id))]);
      setMore(page.more);
    } catch { if (revision === queryRevision.current) setFailed(true); }
    finally { if (revision === queryRevision.current) setPending(false); }
  }, [api]);

  useEffect(() => { void load(query); }, [load, query]);
  // The newest page merges into the list without a reload, so loaded older pages and the selection stay.
  const queryRef = useRef(query); queryRef.current = query;
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const addNewest = useCallback(async () => {
    const revision = listRevision.current;
    try {
      const page = await api.query(queryRef.current);
      if (revision !== listRevision.current) return;
      setChanged(false);
      const newest = rowsRef.current[0]?.id ?? 0, added = page.records.filter(row => row.id > newest);
      // A full page of new records may leave a gap before the loaded ones, so the list restarts from this page.
      if (added.length >= recordsPageSize) { setRows(page.records); setMore(page.more); }
      else if (added.length) setRows(existing => [...added.filter(row => row.id > (existing[0]?.id ?? 0)), ...existing]);
    } catch { if (revision === listRevision.current) setFailed(true); }
  }, [api]);
  const atTop = () => (list.current?.scrollTop ?? 0) <= 8;
  // A read that failed is retried when the next record arrives, or when a filter changes.
  const failedRef = useRef(failed); failedRef.current = failed;
  useEffect(() => api.onRecordsChanged(() => {
    if (failedRef.current) void load(queryRef.current);
    else if (atTop()) void addNewest(); else setChanged(true);
  }), [api, addNewest, load]);
  // Typing settles briefly before it queries; the filters apply at once.
  useEffect(() => {
    if (search === query.search) return;
    const timer = setTimeout(() => setQuery(q => ({ ...q, search })), 250);
    return () => clearTimeout(timer);
  }, [search, query.search]);

  const choose = async (id: number) => {
    setSelected(id); setDetail(undefined);
    const revision = ++detailRevision.current;
    try { const text = await api.detail(id); if (revision === detailRevision.current) setDetail(text); }
    catch { if (revision === detailRevision.current) { setDetail(null); setFailed(true); } }
  };

  const loadOlder = () => { if (!pending && !failed && more && rows.length) void load(query, rows.at(-1)!.id); };
  const activeIndex = rows.findIndex(row => row.id === selected);
  useEffect(() => { if (activeIndex >= 0) document.getElementById(`record-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);
  const onListKey = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || !rows.length) return;
    const page = Math.max(1, Math.floor((list.current?.clientHeight ?? 400) / 56));
    const target = { ArrowDown: activeIndex + 1, ArrowUp: Math.max(0, activeIndex - 1), Home: 0, End: rows.length - 1, PageDown: activeIndex + page, PageUp: activeIndex - page }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(rows.length - 1, target));
    if (index === rows.length - 1 && event.key !== 'Home') loadOlder();
    void choose(rows[index]!.id);
  };

  const widest = Math.max(LIST_MIN, shellWidth - DETAIL_MIN);
  const shown = Math.max(LIST_MIN, Math.min(drag ?? keyed ?? width, widest));
  // Keys move the splitter at once; the width is saved once, when the key is released or focus leaves.
  const saveKeyed = () => { if (keyed === null) return; setKeyed(null); if (keyed !== width) saveWidth(keyed); };
  const saveWidth = (value: number) => { setWidth(value); void api.resizeList(value).catch(() => setFailed(true)); };
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget, startX = event.clientX, start = shown; let latest = start;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => { latest = Math.max(LIST_MIN, Math.min(start + e.clientX - startX, shellWidth - DETAIL_MIN)); setDrag(latest); };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); setDrag(null); if (latest !== start) saveWidth(latest); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  };

  const record = detail ? parseRecord(detail) : undefined;
  const status = pending ? t('logs.loading') : failed ? t('logs.failed') : changed ? t('logs.newRecords') : rows.length ? '' : t('logs.empty');

  return (
    <div className="records-shell" ref={shell}>
      <section className="records-pane" style={{ width: shown }}>
        <div className="records-filters">
          <input type="search" value={search} maxLength={500} placeholder={t('logs.search')} aria-label={t('logs.search')} onChange={event => setSearch(event.target.value)} />
          <div className="records-filter-row">
            <select aria-label={t('logs.launch')} value={current ? 'current' : 'all'} onChange={event => { const value = event.target.value === 'current'; setCurrent(value); setQuery(q => ({ ...q, current: value })); }}>
              <option value="current">{t('logs.currentLaunch')}</option>
              <option value="all">{t('logs.allLaunches')}</option>
            </select>
            <select aria-label={t('logs.level')} value={level} onChange={event => { const value = event.target.value as RecordsQuery['level']; setLevel(value); setQuery(q => ({ ...q, level: value })); }}>
              {LEVELS.map(value => <option key={value} value={value}>{t(value === 'all' ? 'logs.allLevels' : `logs.${value}`)}</option>)}
            </select>
          </div>
          <div className="records-status-row">
            <span className={`records-state${failed ? ' problem' : ''}`} role="status">{status}</span>
          </div>
        </div>
        <div
          ref={list} className="records-rows" role="listbox" tabIndex={0} aria-label={t('ui.logs')}
          aria-activedescendant={activeIndex >= 0 ? `record-${activeIndex}` : undefined} onKeyDown={onListKey}
          onScroll={event => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) loadOlder(); if (changed && atTop()) void addNewest(); }}
        >
          {rows.map((row, index) => (
            <div key={row.id} id={`record-${index}`} role="option" aria-selected={row.id === selected} className={`record-card${row.id === selected ? ' selected' : ''}`} onClick={() => void choose(row.id)}>
              <span className="record-line"><span className={`pill level-${row.level}`}>{t(`logs.${row.level}`)}</span><time className="record-time" dateTime={row.time}>{formatTime(row.time)}</time></span>
              <span className="record-text">{row.message}</span>
            </div>
          ))}
        </div>
      </section>
      <div className="splitter" role="separator" aria-orientation="vertical" tabIndex={0} aria-label={t('logs.splitter')} aria-valuemin={LIST_MIN} aria-valuemax={Math.round(widest)} aria-valuenow={Math.round(shown)}
        onPointerDown={startDrag}
        onKeyDown={event => {
          if (isComposing(event.nativeEvent)) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setKeyed(Math.max(LIST_MIN, Math.min(shown + (event.key === 'ArrowRight' ? SPLITTER_STEP : -SPLITTER_STEP), widest))); }
          else if (event.key === 'Home') { event.preventDefault(); setKeyed(LIST_MIN); }
          else if (event.key === 'End') { event.preventDefault(); setKeyed(widest); }
        }}
        onKeyUp={saveKeyed} onBlur={saveKeyed}
      />
      <section className="records-detail" aria-label={t('logs.detail')}>
        {selected === undefined ? <p className="records-state">{t('logs.select')}</p> : detail === undefined ? <p className="records-state">{t('logs.loading')}</p> : (
          <>
            {record && record.fields.length > 0 && (
              <dl className="records-fields">
                {record.fields.map(([key, value]) => <div key={key} className="records-field"><dt>{t(`logs.${key}`)}</dt><dd>{value}</dd></div>)}
              </dl>
            )}
            <div className="records-block">
              <h2>{t('logs.raw')}</h2>
              <pre tabIndex={0}>{detail ?? t('logs.empty')}</pre>
            </div>
          </>
        )}
        <p className="records-privacy">{t('logs.privacy')}</p>
      </section>
    </div>
  );
}

/** The structured fields of a record, when its payload has them; older payloads stay raw only. */
function parseRecord(text: string): { fields: [string, string][] } | undefined {
  try {
    const record = JSON.parse(text), event = record.event ?? {};
    const values: Record<string, unknown> = { time: event.time, action: event.action ?? event.verb ?? event.event?.verb ?? event.type, session: event.sessionId ?? record.session, model: event.modelId ?? event.model ?? event.event?.modelId, message: event.message };
    return { fields: Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, key === 'time' ? formatTime(value) : value]) };
  } catch { return undefined; }
}
