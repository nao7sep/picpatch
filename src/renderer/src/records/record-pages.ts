// The Records list's pages: the newest 100 first, older pages appended on request, and
// newest pages merged in at the top. The window has one list read at a time; a newer
// read supersedes the one in flight, whose answer is dropped, since IPC cannot be
// cancelled. A failed read stops paging until a record arrives or a filter changes.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordsBridge } from '../../../shared/records-bridge.ts';
import type { RecordsPage, RecordsQuery, RecordSummary } from '../../../shared/records.ts';

type Loaded = { records: RecordSummary[]; more: boolean };

/** A newest page joins the loaded list; a page with no overlap may leave a gap, so the list restarts from it. */
export function mergeNewest(loaded: Loaded, page: RecordsPage): Loaded {
  const newest = loaded.records[0]?.id ?? 0;
  const added = page.records.filter(row => row.id > newest);
  if (added.length === page.records.length && page.more) return { records: page.records, more: page.more };
  return { records: [...added, ...loaded.records], more: loaded.records.length ? loaded.more : page.more };
}

export function useRecordPages(api: RecordsBridge, query: Omit<RecordsQuery, 'before'>) {
  const loaded = useRef<Loaded>({ records: [], more: false });
  const [revision, redraw] = useState(0);
  const changed = () => redraw(value => value + 1);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  /** Which read failed; another read of that kind is its retry. */
  const failure = useRef<'newest' | 'more' | undefined>(undefined);
  const reader = useRef<'newest' | 'more' | undefined>(undefined);
  const token = useRef(0);
  const queryRef = useRef(query);

  const begin = (kind: 'newest' | 'more') => { reader.current = kind; return ++token.current; };
  const end = (read: number) => { if (read !== token.current) return; reader.current = undefined; changed(); };

  /** `shown` is asked when the page arrives; when it answers false the page is dropped, so the list does not move. */
  const readNewest = useCallback(async (shown: () => boolean = () => true) => {
    const read = begin('newest');
    try {
      const page = await api.query(queryRef.current);
      if (read !== token.current || !shown()) return;
      loaded.current = mergeNewest(loaded.current, page);
      if (failure.current === 'newest') failure.current = undefined;
      setStatus('ready');
    } catch {
      if (read === token.current) { failure.current = 'newest'; setStatus('ready'); }
    } finally { end(read); }
  }, [api]);

  /**
   * `drawn` is how many rows the list had when it was measured; a page that has arrived since is not on screen yet,
   * so that measurement says nothing about it, and the list asks again once it is drawn.
   */
  const readMore = useCallback(async (retry = false, drawn?: number) => {
    const { records, more } = loaded.current;
    if (!more || !records.length || reader.current || (drawn !== undefined && drawn !== records.length) || (failure.current && !(retry && failure.current === 'more'))) return;
    const read = begin('more'); changed();
    const last = records.at(-1)!.id;
    try {
      const page = await api.query({ ...queryRef.current, before: last });
      if (read !== token.current) return;
      loaded.current = { records: [...loaded.current.records, ...page.records.filter(row => row.id < last)], more: page.more };
      failure.current = undefined;
    } catch {
      if (read === token.current) failure.current = 'more';
    } finally { end(read); }
  }, [api]);

  // A filter change starts the list over.
  useEffect(() => {
    queryRef.current = query;
    loaded.current = { records: [], more: false }; failure.current = undefined;
    setStatus('loading'); changed();
    void readNewest();
  }, [query, readNewest]);

  return { records: loaded.current.records, revision, status, failure: failure.current, reading: reader.current, readNewest, readMore };
}
