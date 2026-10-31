// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecordsWindow } from '../../src/renderer/src/records/RecordsWindow.tsx';
import type { RecordsBridge } from '../../src/shared/records-bridge.ts';
import type { RecordSummary } from '../../src/shared/records.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom lays nothing out, so the list's measures are given here, as Chromium would report them: the list
// is 500 px tall, each row 52 px with 2 px between rows, and its content as tall as the rows the list places.
const owner = (name: string) => { let proto: object | null = HTMLElement.prototype; while (proto && !Object.getOwnPropertyDescriptor(proto, name)) proto = Object.getPrototypeOf(proto); return proto as HTMLElement; };
const layout = { listHeight: 500 };
beforeEach(() => {
  layout.listHeight = 500;
  vi.spyOn(owner('clientHeight'), 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('records-rows') ? layout.listHeight : 0; });
  vi.spyOn(owner('offsetHeight'), 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('record-card') ? 52 : 0; });
  vi.spyOn(owner('scrollHeight'), 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('records-rows') ? parseFloat(this.querySelector<HTMLElement>('.records-rows-inner')?.style.height ?? '') || 0 : 0;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
/** The rendered rows, in list order, by their place in the whole list. */
const options = (list: HTMLElement) => within(list).queryAllByRole('option').sort((a, b) => Number(a.getAttribute('aria-posinset')) - Number(b.getAttribute('aria-posinset')));

const row = (id: number, message: string, level: RecordSummary['level'] = 'info'): RecordSummary => ({ id, session: 's', time: '2026-10-01T00:00:00.000Z', level, message });
function bridge(overrides: Partial<RecordsBridge> = {}) {
  let changed: (() => void) | undefined;
  const api: RecordsBridge = {
    appearance: vi.fn(async () => ({ locale: { language: 'en' as const, format: 'en' }, dark: false })),
    query: vi.fn(async query => ({ records: query.before ? [row(1, 'Oldest')] : [row(3, '<b>Literal</b>', 'error'), row(2, 'Second')], more: !query.before })),
    detail: vi.fn(async id => JSON.stringify({ event: { action: 'submit', message: `Detail ${id}` } })),
    resizeList: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onRecordsChanged: listener => { changed = listener; return () => {}; },
    onAppearanceChanged: () => () => {},
    ...overrides,
  };
  return { api, change: () => changed?.() };
}

it('lists records literally and adds new records live at the top, keeping the selection', async () => {
  let newest = 3;
  const { api, change } = bridge({ query: vi.fn(async query => ({ records: query.before ? [row(1, 'Oldest')] : [...(newest > 3 ? [row(4, 'Arrived')] : []), row(3, '<b>Literal</b>', 'error'), row(2, 'Second')], more: !query.before })) });
  render(<RecordsWindow api={api} />);
  expect(await screen.findByText('<b>Literal</b>')).toBeTruthy();
  expect(document.querySelector('.pill.level-error')!.textContent).toBe('Error');
  fireEvent.click(screen.getByText('Second'));
  expect(await screen.findByText('Detail 2')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  newest = 4; await act(async () => change());
  const list = screen.getByRole('listbox', { name: 'Records' });
  await waitFor(() => expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringContaining('Arrived'), expect.stringContaining('Literal'), expect.stringContaining('Second'), expect.stringContaining('Oldest')]));
  expect(within(list).getByRole('option', { selected: true }).textContent).toContain('Second');
  expect(screen.getByText('Detail 2')).toBeTruthy();
});

it('holds new records while the list is scrolled away, with no notice, and adds them on return to the top', async () => {
  let newest = 3;
  const { api, change } = bridge({ query: vi.fn(async query => ({ records: query.before ? [] : [...(newest > 3 ? [row(4, 'Arrived')] : []), row(3, 'Third'), row(2, 'Second')], more: false })) });
  render(<RecordsWindow api={api} />);
  await screen.findByText('Third');
  const list = screen.getByRole('listbox', { name: 'Records' });
  list.scrollTop = 200; newest = 4;
  await act(async () => change());
  expect(screen.queryByText('Arrived')).toBeNull(); expect(screen.getByRole('status').textContent).toBe('');
  list.scrollTop = 0; fireEvent.scroll(list);
  expect(await screen.findByText('Arrived')).toBeTruthy();
});

it('drops a newest page that lands after the list left its top, and reads it again back at the top', async () => {
  const releases: (() => void)[] = [];
  let reads = 0;
  const query = vi.fn<RecordsBridge['query']>(async request => {
    if (request.before) return { records: [], more: false };
    if (++reads === 1) return { records: [row(3, 'Third')], more: false };
    return new Promise(resolve => releases.push(() => resolve({ records: [row(4, 'Arrived'), row(3, 'Third')], more: false })));
  });
  const { api, change } = bridge({ query });
  render(<RecordsWindow api={api} />);
  await screen.findByText('Third');
  await act(async () => change());
  const list = screen.getByRole('listbox', { name: 'Records' });
  list.scrollTop = 120;
  await act(async () => releases.shift()!());
  expect(screen.queryByText('Arrived')).toBeNull();
  list.scrollTop = 0; fireEvent.scroll(list);
  await waitFor(() => expect(releases).toHaveLength(1));
  await act(async () => releases.shift()!());
  expect(await screen.findByText('Arrived')).toBeTruthy();
});

it('moves the splitter 16 px per arrow press, reaches its bounds with Home and End, and saves after the last step', async () => {
  const { api } = bridge();
  render(<RecordsWindow api={api} />);
  await screen.findByText('Second');
  const splitter = screen.getByRole('separator');
  const start = Number(splitter.getAttribute('aria-valuenow'));
  for (let i = 0; i < 3; i++) { fireEvent.keyDown(splitter, { key: 'ArrowRight' }); fireEvent.keyUp(splitter, { key: 'ArrowRight' }); }
  expect(Number(splitter.getAttribute('aria-valuenow'))).toBe(start + 48); expect(api.resizeList).not.toHaveBeenCalled();
  await waitFor(() => expect(api.resizeList).toHaveBeenCalledTimes(1)); expect(api.resizeList).toHaveBeenLastCalledWith(start + 48);
  fireEvent.keyDown(splitter, { key: 'End' });
  expect(splitter.getAttribute('aria-valuenow')).toBe(splitter.getAttribute('aria-valuemax'));
  // Leaving the splitter saves a step still waiting.
  fireEvent.keyDown(splitter, { key: 'Home' }); fireEvent.blur(splitter);
  expect(api.resizeList).toHaveBeenLastCalledWith(320); expect(api.resizeList).toHaveBeenCalledTimes(2);
});

it('queries each filter change and settles typed search before querying', async () => {
  const { api } = bridge();
  render(<RecordsWindow api={api} />);
  await screen.findByText('Second');
  fireEvent.change(screen.getByRole('combobox', { name: 'Severity' }), { target: { value: 'warningsAndErrors' } });
  await waitFor(() => expect(api.query).toHaveBeenLastCalledWith({ current: true, level: 'warningsAndErrors', search: '' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), { target: { value: 'disk' } });
  expect(api.query).not.toHaveBeenLastCalledWith(expect.objectContaining({ search: 'disk' }));
  await waitFor(() => expect(api.query).toHaveBeenLastCalledWith({ current: true, level: 'warningsAndErrors', search: 'disk' }));
});

it('drops a detail that arrives after a newer selection', async () => {
  let release: (value: string) => void = () => {};
  const { api } = bridge({ detail: vi.fn(id => id === 3 ? new Promise<string>(resolve => { release = resolve; }) : Promise.resolve(JSON.stringify({ event: { message: 'Fresh' } }))) });
  render(<RecordsWindow api={api} />);
  fireEvent.click(await screen.findByText('<b>Literal</b>'));
  fireEvent.click(screen.getByText('Second'));
  expect(await screen.findByText('Fresh')).toBeTruthy();
  await act(async () => release(JSON.stringify({ event: { message: 'Stale' } })));
  expect(screen.queryByText('Stale')).toBeNull();
});

it('shows a failed detail read in the detail pane, leaving the list as it is', async () => {
  const { api } = bridge({ detail: vi.fn(async () => { throw new Error('locked'); }) });
  render(<RecordsWindow api={api} />);
  fireEvent.click(await screen.findByText('Second'));
  const detail = screen.getByRole('region', { name: 'Record details' });
  expect(await within(detail).findByText('Records could not be read.')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('');
});

it('keeps a failed read visible until the next record arrives, then reads again', async () => {
  const query = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue({ records: [row(5, 'Back')], more: false });
  const { api, change } = bridge({ query });
  render(<RecordsWindow api={api} />);
  expect(await screen.findByText('Records could not be read.')).toBeTruthy();
  expect(query).toHaveBeenCalledTimes(1);
  await act(async () => change());
  expect(await screen.findByText('Back')).toBeTruthy();
});

it('shows record times in the display zone and follows a change of zone', async () => {
  let timeZone = 'UTC'; let changed: () => void = () => {};
  const { api } = bridge({ appearance: vi.fn(async () => ({ locale: { language: 'en' as const, format: 'en' }, dark: false, timeZone })), onAppearanceChanged: listener => { changed = listener; return () => {}; } });
  render(<RecordsWindow api={api} />);
  await waitFor(() => expect(screen.getAllByText('Oct 1, 2026, 12:00:00 AM')).toHaveLength(3));
  timeZone = 'Asia/Tokyo'; await act(async () => changed());
  await waitFor(() => expect(screen.getAllByText('Oct 1, 2026, 9:00:00 AM')).toHaveLength(3));
});

it('retries a failed older page when a record arrives while the list is at the top', async () => {
  let older = 0;
  const query = vi.fn<RecordsBridge['query']>(async request => {
    if (!request.before) return { records: [row(3, 'Third'), row(2, 'Second')], more: true };
    if (++older === 1) throw new Error('locked');
    return { records: [row(1, 'Oldest')], more: false };
  });
  const { api, change } = bridge({ query });
  render(<RecordsWindow api={api} />);
  expect(await screen.findByText('Records could not be read.')).toBeTruthy();
  expect(screen.queryByText('Oldest')).toBeNull();
  // The newest page read for the arrival comes first; the older page is read after it, not superseded by it.
  await act(async () => change());
  expect(await screen.findByText('Oldest')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('');
  expect(query.mock.calls.map(([request]) => request.before)).toEqual([undefined, 2, undefined, 2]);
});

it('loads several pages by itself while the list is shorter than the window, and stops once a screen is left below', async () => {
  // Each page answers a moment later, as the records thread would.
  layout.listHeight = 6000;
  const store = Array.from({ length: 1000 }, (_, i) => row(1000 - i, `Record ${1000 - i}`));
  const query = vi.fn<RecordsBridge['query']>(async ({ before }) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    const older = before ? store.filter(item => item.id < before) : store;
    return { records: older.slice(0, 100), more: older.length > 100 };
  });
  const { api } = bridge({ query });
  render(<RecordsWindow api={api} />);
  const list = await screen.findByRole('listbox', { name: 'Records' });
  // 100 rows (5,398 px) and then 200 (10,798 px) leave no more than the 6,000 px view below; 300 rows leave more.
  await waitFor(() => expect(options(list).at(-1)?.getAttribute('aria-setsize')).toBe('300'));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(query.mock.calls.map(([request]) => request.before)).toEqual([undefined, 901, 801]);
  expect(list.getAttribute('aria-busy')).toBe('false');
});

it('pages 10,000 records newest first, each once, rendering only rows near the view, and takes live arrivals only at the top', async () => {
  const store: RecordSummary[] = [];
  const add = (count: number) => { for (let i = 0; i < count; i++) store.push(row(store.length + 1, `Record ${store.length + 1}`)); };
  add(10_000);
  layout.listHeight = 2_000;
  const query = vi.fn<RecordsBridge['query']>(async ({ before }) => {
    const older = before ? store.slice(0, before - 1) : store;
    return { records: older.slice(-100).reverse(), more: older.length > 100 };
  });
  const { api, change } = bridge({ query });
  render(<RecordsWindow api={api} />);
  const list = await screen.findByRole('listbox', { name: 'Records' });
  const place = (option: HTMLElement) => ({ pos: Number(option.getAttribute('aria-posinset')), size: Number(option.getAttribute('aria-setsize')), id: Number(option.dataset.recordId) });
  const settled = () => waitFor(() => { expect(list.getAttribute('aria-busy')).toBe('false'); expect(options(list).length).toBeGreaterThan(0); });

  // Walking down a screen at a time loads every record once, in order, with only rows near the view in the page.
  const seen = new Map<number, number>();
  let conflicts = 0, widest = 0;
  for (;;) {
    await settled();
    const rows = options(list).map(place);
    widest = Math.max(widest, rows.length);
    for (const { pos, id } of rows) { if (seen.has(pos) && seen.get(pos) !== id) conflicts++; seen.set(pos, id); }
    const last = rows.at(-1)!;
    if (last.pos === 10_000 && last.size === 10_000) break;
    const top = Math.min(list.scrollTop + list.clientHeight, list.scrollHeight - list.clientHeight);
    if (top <= list.scrollTop) throw new Error(`The walk stopped at row ${last.pos} of ${last.size}.`);
    list.scrollTop = top;
    await act(async () => { fireEvent.scroll(list); });
  }
  expect(conflicts).toBe(0);
  expect(Array.from(seen.keys()).sort((a, b) => a - b)).toEqual(Array.from({ length: 10_000 }, (_, i) => i + 1));
  for (const [pos, id] of seen) expect(id).toBe(10_001 - pos);
  expect(widest).toBeLessThan(100);
  expect(new Set(query.mock.calls.map(([request]) => request.before)).size).toBe(query.mock.calls.length);

  // Scrolled away with a record selected, arrivals change nothing: offset, first row, selection and detail stay.
  list.scrollTop = 3_000; await act(async () => { fireEvent.scroll(list); });
  const chosen = place(options(list)[5]!);
  fireEvent.click(options(list)[5]!);
  expect(await screen.findByText(`Detail ${chosen.id}`)).toBeTruthy();
  const before = place(options(list)[0]!);
  for (let second = 0; second < 5; second++) { add(3); await act(async () => change()); }
  expect(list.scrollTop).toBe(3_000); expect(place(options(list)[0]!)).toEqual(before);
  expect(place(within(list).getByRole('option', { selected: true }))).toEqual(chosen);

  // Back at the top, the waiting records join above, keeping the selection and its detail.
  list.scrollTop = 0; await act(async () => { fireEvent.scroll(list); });
  await waitFor(() => expect(place(options(list)[0]!)).toEqual({ pos: 1, size: 10_015, id: 10_015 }));
  expect(screen.getByText(`Detail ${chosen.id}`)).toBeTruthy();
  list.scrollTop = (10_015 - chosen.id) * 54; await act(async () => { fireEvent.scroll(list); });
  expect(place(within(list).getByRole('option', { selected: true }))).toEqual({ pos: 10_016 - chosen.id, size: 10_015, id: chosen.id });

  // At the top, each arrival shows at once.
  list.scrollTop = 0; await act(async () => { fireEvent.scroll(list); });
  add(3); await act(async () => change());
  await waitFor(() => expect(place(options(list)[0]!)).toEqual({ pos: 1, size: 10_018, id: 10_018 }));
});
