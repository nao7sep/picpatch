// The Records window: the app's diagnostic history, filtered by launch, severity and
// text, newest first, with the selected record's fields and raw detail beside it.
// Pages of 100 load newest first as the list nears its end. New records join the top only while the list is
// at its top, keeping the selection and its detail; scrolled away, nothing moves until the list returns there.
// Only the rows in and near the view are rendered, each placed at its measured offset, so a long list stays light.
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { activeLocale, t, useLocale } from '../../../shared/i18n/index.ts';
import type { RecordsBridge } from '../../../shared/records-bridge.ts';
import type { RecordSummary, RecordsQuery } from '../../../shared/records.ts';
import { displayTimeZone } from '../../../shared/time-zone.ts';
import { applyFont } from '../fonts.ts';
import { LanguageRevision, useI18n } from '../i18n.tsx';
import { DelayedSave } from '../delayed-save.ts';
import { isComposing } from '../ime.ts';
import { useRecordPages } from './record-pages.ts';

declare global { interface Window { picpatchRecords: RecordsBridge } }

const LIST_MIN = 320, DETAIL_MIN = 440, SPLITTER_STEP = 16;
/** A row's height before it is measured, and the space between rows. */
const ROW_ESTIMATE = 52, ROW_GAP = 2;
const LEVELS = ['all', 'warningsAndErrors', 'error', 'warn', 'info', 'debug'] as const;

export function RecordsWindow({ api }: { api: RecordsBridge }) {
  const [revision, setRevision] = useState(-1);
  useEffect(() => {
    let stopped = false;
    const apply = async () => {
      try {
        const view = await api.appearance(); if (stopped) return;
        applyFont(view.uiFont); await useLocale(view.locale); zone = displayTimeZone(view.timeZone);
        document.documentElement.lang = view.locale.language; document.title = t('ui.records');
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

/** The display zone, set with the window's appearance before each render. */
let zone = displayTimeZone(undefined);
/** One formatter per locale and zone, since a long list formats every row on each render. */
let formatter: { key: string; format: Intl.DateTimeFormat } | undefined;
function formatTime(value: string) {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return value;
  const key = `${activeLocale().format}\n${zone}`;
  if (formatter?.key !== key) formatter = { key, format: new Intl.DateTimeFormat(activeLocale().format, { dateStyle: 'medium', timeStyle: 'medium', timeZone: zone }) };
  return formatter.format.format(instant);
}

// Measurements are the list's own scroll offset, visible height and content height.
/** The next page is wanted while what is left below the visible part is no more than the visible height. */
const nearEnd = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight <= list.clientHeight;
const atTop = (list: HTMLElement) => list.scrollTop < 1;

function Records({ api }: { api: RecordsBridge }) {
  const [current, setCurrent] = useState(true);
  const [level, setLevel] = useState<RecordsQuery['level']>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<Omit<RecordsQuery, 'before'>>({ current: true, level: 'all', search: '' });
  const pages = useRecordPages(api, query);
  const { records: rows, readNewest, readMore } = pages;
  const [selected, setSelected] = useState<number>();
  const [detail, setDetail] = useState<string | null | undefined>();
  const [detailFailed, setDetailFailed] = useState(false);
  const [width, setWidth] = useState<number>(LIST_MIN);
  const [drag, setDrag] = useState<number | null>(null);
  // The detail token changes when another record is chosen or the list restarts; IPC cannot be cancelled.
  const detailToken = useRef(0);
  const list = useRef<HTMLDivElement>(null), shell = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(1100);
  /** New records arrived, or a newest page was dropped, while the list was away from its top. */
  const newestWaiting = useRef(false);

  useEffect(() => { void api.appearance().then(view => { if (view.listWidth) setWidth(view.listWidth); }, () => {}); }, [api]);
  useEffect(() => {
    const element = shell.current; if (!element) return;
    const observer = new ResizeObserver(() => setShellWidth(element.clientWidth)); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Main records a failed close itself.
      if (!isComposing(event) && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'w') { event.preventDefault(); void api.close().catch(() => {}); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [api]);

  // A filter change clears the selection with the list.
  useEffect(() => { ++detailToken.current; newestWaiting.current = false; setSelected(undefined); setDetail(undefined); }, [query]);
  // New records appear only while the list is at its top; otherwise nothing moves until it is back there,
  // including a newest page that was already being read when the list left the top.
  const readNewestAtTop = useCallback(() => readNewest(() => {
    const element = list.current;
    if (!element || atTop(element)) return true;
    newestWaiting.current = true; return false;
  }), [readNewest]);
  const failureRef = useRef(pages.failure); failureRef.current = pages.failure;
  useEffect(() => api.onRecordsChanged(() => {
    // An arrival is also the retry of a failed older page. The window has one list read at a time, so at the top
    // the retry follows the newest page instead of being superseded by it.
    const retry = failureRef.current === 'more';
    const element = list.current;
    if (!element || atTop(element)) void readNewestAtTop().then(() => { if (retry) void readMore(true); });
    else { newestWaiting.current = true; if (retry) void readMore(true); }
  }), [api, readMore, readNewestAtTop]);
  const onScroll = () => {
    const element = list.current; if (!element) return;
    if (newestWaiting.current && atTop(element)) { newestWaiting.current = false; void readNewestAtTop(); }
    if (nearEnd(element)) void readMore(false, rows.length);
  };
  // Typing settles briefly before it queries; the filters apply at once.
  useEffect(() => {
    if (search === query.search) return;
    const timer = setTimeout(() => setQuery(q => ({ ...q, search })), 250);
    return () => clearTimeout(timer);
  }, [search, query.search]);

  const choose = async (id: number) => {
    setSelected(id); setDetail(undefined); setDetailFailed(false);
    const token = ++detailToken.current;
    try { const text = await api.detail(id); if (token === detailToken.current) setDetail(text); }
    catch { if (token === detailToken.current) setDetailFailed(true); }
  };

  const chooseRef = useRef(choose); chooseRef.current = choose;
  const chooseRow = useCallback((id: number) => { void chooseRef.current(id); }, []);

  const virtualizer = useVirtualizer({
    count: rows.length, getScrollElement: () => list.current, getItemKey: index => rows[index]!.id,
    estimateSize: () => ROW_ESTIMATE, gap: ROW_GAP, overscan: 8, useFlushSync: false,
    initialRect: { width: 0, height: window.innerHeight },
  });
  const virtualRows = virtualizer.getVirtualItems();
  // Each settled read, and each change in the measured height of the rows, checks again, so pages keep loading
  // while the list is short of filling the window.
  const contentHeight = virtualizer.getTotalSize();
  useEffect(() => {
    const element = list.current;
    if (element && pages.status === 'ready' && nearEnd(element)) void readMore(false, rows.length);
  }, [pages.revision, pages.status, contentHeight, readMore]);
  const activeIndex = rows.findIndex(row => row.id === selected);
  const onListKey = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || !rows.length) return;
    const rowHeight = list.current?.querySelector<HTMLElement>('[role=option]')?.offsetHeight ?? 0;
    const page = rowHeight ? Math.max(1, Math.floor(list.current!.clientHeight / rowHeight)) : 1;
    const target = { ArrowDown: activeIndex + 1, ArrowUp: Math.max(0, activeIndex - 1), Home: 0, End: rows.length - 1, PageDown: activeIndex + page, PageUp: activeIndex - page }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(rows.length - 1, target));
    if (index === rows.length - 1 && event.key !== 'Home') void readMore(false, rows.length);
    // Only the keys move the view to the chosen row; records joining the top leave it where it is.
    virtualizer.scrollToIndex(index, { align: 'auto' });
    void choose(rows[index]!.id);
  };

  const widest = Math.max(LIST_MIN, shellWidth - DETAIL_MIN);
  const shown = Math.max(LIST_MIN, Math.min(drag ?? width, widest));
  // Keys move the splitter at once and save a short delay after the last step; a drag saves when it ends.
  // Main records a failed save itself.
  const [widthSave] = useState(() => new DelayedSave<number>(value => api.resizeList(value).catch(() => {})));
  useEffect(() => {
    const flush = () => { void widthSave.flush(); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [widthSave]);
  const stepWidth = (value: number) => { if (value === width) return; setWidth(value); widthSave.later(value); };
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.currentTarget, startX = event.clientX, start = shown; let latest = start;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => { latest = Math.max(LIST_MIN, Math.min(start + e.clientX - startX, shellWidth - DETAIL_MIN)); setDrag(latest); };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); setDrag(null); if (latest !== start) { setWidth(latest); void widthSave.now(latest); } };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
  };

  const record = detail ? parseRecord(detail) : undefined;
  const failed = pages.failure !== undefined;
  const status = pages.status === 'loading' ? t('records.loading') : failed ? t('records.failed') : rows.length ? '' : t('records.empty');

  return (
    <div className="records-shell" ref={shell}>
      <section className="records-pane" style={{ width: shown }}>
        <div className="records-filters">
          <input type="search" value={search} maxLength={500} placeholder={t('records.search')} aria-label={t('records.search')} onChange={event => setSearch(event.target.value)} />
          <div className="records-filter-row">
            <select aria-label={t('records.launch')} value={current ? 'current' : 'all'} onChange={event => { const value = event.target.value === 'current'; setCurrent(value); setQuery(q => ({ ...q, current: value })); }}>
              <option value="current">{t('records.currentLaunch')}</option>
              <option value="all">{t('records.allLaunches')}</option>
            </select>
            <select aria-label={t('records.level')} value={level} onChange={event => { const value = event.target.value as RecordsQuery['level']; setLevel(value); setQuery(q => ({ ...q, level: value })); }}>
              {LEVELS.map(value => <option key={value} value={value}>{t(value === 'all' ? 'records.allLevels' : `records.${value}`)}</option>)}
            </select>
          </div>
          <div className="records-status-row">
            <span className={`records-state${failed ? ' problem' : ''}`} role="status">{status}</span>
          </div>
        </div>
        <div
          ref={list} className="records-rows" role="listbox" tabIndex={0} aria-label={t('ui.records')} aria-busy={pages.reading !== undefined}
          aria-activedescendant={virtualRows.some(item => item.index === activeIndex) ? `record-${rows[activeIndex]!.id}` : undefined} onKeyDown={onListKey} onScroll={onScroll}
        >
          <div className="records-rows-inner" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map(item => (
              <RecordRow key={item.key} row={rows[item.index]!} index={item.index} count={rows.length} start={item.start} selected={rows[item.index]!.id === selected} onChoose={chooseRow} measure={virtualizer.measureElement} />
            ))}
          </div>
        </div>
      </section>
      <div className="splitter" role="separator" aria-orientation="vertical" tabIndex={0} aria-label={t('records.splitter')} aria-valuemin={LIST_MIN} aria-valuemax={Math.round(widest)} aria-valuenow={Math.round(shown)}
        onPointerDown={startDrag}
        onKeyDown={event => {
          if (isComposing(event.nativeEvent)) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepWidth(Math.max(LIST_MIN, Math.min(shown + (event.key === 'ArrowRight' ? SPLITTER_STEP : -SPLITTER_STEP), widest))); }
          else if (event.key === 'Home') { event.preventDefault(); stepWidth(LIST_MIN); }
          else if (event.key === 'End') { event.preventDefault(); stepWidth(widest); }
        }}
        onBlur={() => void widthSave.flush()}
      />
      <section className="records-detail" aria-label={t('records.detail')}>
        {selected === undefined ? <p className="records-state">{t('records.select')}</p> : detailFailed ? <p className="records-state problem">{t('records.failed')}</p> : detail === undefined ? <p className="records-state">{t('records.loading')}</p> : (
          <>
            {record && record.fields.length > 0 && (
              <dl className="records-fields">
                {record.fields.map(([key, value]) => <div key={key} className="records-field"><dt>{t(`records.${key}`)}</dt><dd>{value}</dd></div>)}
              </dl>
            )}
            <div className="records-block">
              <h2>{t('records.raw')}</h2>
              <pre tabIndex={0}>{detail ?? t('records.empty')}</pre>
            </div>
          </>
        )}
        <p className="records-privacy">{t('records.privacy')}</p>
      </section>
    </div>
  );
}

/** A row re-renders only when its record, place or selection changes, or the language or zone does. */
const RecordRow = memo(function RecordRow({ row, index, count, start, selected, onChoose, measure }: {
  row: RecordSummary; index: number; count: number; start: number; selected: boolean; onChoose: (id: number) => void; measure: (element: HTMLElement | null) => void;
}) {
  useI18n();
  const style: CSSProperties = { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${start}px)` };
  return (
    <div
      ref={measure} data-index={index} data-record-id={row.id} style={style} id={`record-${row.id}`} role="option" aria-posinset={index + 1} aria-setsize={count}
      aria-selected={selected} className={`record-card${selected ? ' selected' : ''}`} onClick={() => onChoose(row.id)}
    >
      <span className="record-line"><span className={`pill level-${row.level}`}>{t(`records.${row.level}`)}</span><time className="record-time" dateTime={row.time}>{formatTime(row.time)}</time></span>
      <span className="record-text">{row.message}</span>
    </div>
  );
});

/** The structured fields of a record, when its payload has them; older payloads stay raw only. */
function parseRecord(text: string): { fields: [string, string][] } | undefined {
  try {
    const record = JSON.parse(text), event = record.event ?? {};
    const values: Record<string, unknown> = { time: event.time, action: event.action ?? event.verb ?? event.event?.verb ?? event.type, session: event.sessionId ?? record.session, model: event.modelId ?? event.model ?? event.event?.modelId, message: event.message };
    return { fields: Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, key === 'time' ? formatTime(value) : value]) };
  } catch { return undefined; }
}
