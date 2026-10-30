// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecordsWindow } from '../../src/renderer/src/records/RecordsWindow.tsx';
import type { LogsBridge } from '../../src/shared/logs-bridge.ts';
import type { RecordSummary } from '../../src/shared/records.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (id: number, message: string, level: RecordSummary['level'] = 'info'): RecordSummary => ({ id, session: 's', time: '2026-10-01T00:00:00.000Z', level, message });
function bridge(overrides: Partial<LogsBridge> = {}) {
  let changed: (() => void) | undefined;
  const api: LogsBridge = {
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
  const query = vi.fn<LogsBridge['query']>(async request => {
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
  fireEvent.change(screen.getByRole('combobox', { name: 'Severity' }), { target: { value: 'attention' } });
  await waitFor(() => expect(api.query).toHaveBeenLastCalledWith({ current: true, level: 'attention', search: '' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), { target: { value: 'disk' } });
  expect(api.query).not.toHaveBeenLastCalledWith(expect.objectContaining({ search: 'disk' }));
  await waitFor(() => expect(api.query).toHaveBeenLastCalledWith({ current: true, level: 'attention', search: 'disk' }));
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

it('pages 10,000 records newest first, each once, and takes live arrivals only at the top', async () => {
  // The list is 500 px tall and each row 10 px, as the toolkit would report them.
  const owner = (name: string) => { let proto: object | null = HTMLElement.prototype; while (proto && !Object.getOwnPropertyDescriptor(proto, name)) proto = Object.getPrototypeOf(proto); return proto as HTMLElement; };
  vi.spyOn(owner('clientHeight'), 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('records-rows') ? 500 : 0; });
  vi.spyOn(owner('scrollHeight'), 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('records-rows') ? this.children.length * 10 : 0; });
  const store: RecordSummary[] = [];
  const add = (count: number) => { for (let i = 0; i < count; i++) store.push(row(store.length + 1, `Record ${store.length + 1}`)); };
  add(10_000);
  const query = vi.fn<LogsBridge['query']>(async ({ before }) => {
    const older = before ? store.slice(0, before - 1) : store;
    return { records: older.slice(-100).reverse(), more: older.length > 100 };
  });
  const { api, change } = bridge({ query });
  render(<RecordsWindow api={api} />);
  const list = await screen.findByRole('listbox', { name: 'Records' });
  const ids = () => Array.from(list.children, child => Number(child.textContent!.replace(/^.*Record /, '')));

  // The first page leaves exactly the visible height below, so one more page loads, and no further.
  await waitFor(() => expect(list.children).toHaveLength(200));
  expect(query.mock.calls.map(([request]) => request.before)).toEqual([undefined, 9_901]);

  // Scrolling to the end of each page loads the next, until every record is listed once, in order.
  while (list.children.length < 10_000) {
    const shown = list.children.length;
    list.scrollTop = list.scrollHeight - list.clientHeight;
    await act(async () => { fireEvent.scroll(list); });
    await waitFor(() => expect(list.children.length).toBeGreaterThan(shown));
  }
  expect(ids()).toEqual(Array.from({ length: 10_000 }, (_, i) => 10_000 - i));
  expect(new Set(query.mock.calls.map(([request]) => request.before)).size).toBe(query.mock.calls.length);

  // Scrolled away with a record selected, arrivals change nothing: offset, first row, selection and detail stay.
  list.scrollTop = 3_000;
  fireEvent.click(screen.getByText('Record 9500'));
  expect(await screen.findByText('Detail 9500')).toBeTruthy();
  for (let second = 0; second < 5; second++) { add(3); await act(async () => change()); }
  expect(list.scrollTop).toBe(3_000); expect(ids()[0]).toBe(10_000); expect(ids()).toHaveLength(10_000);
  expect(within(list).getByRole('option', { selected: true }).textContent).toContain('Record 9500');

  // Back at the top, the waiting records join above, keeping the selection.
  list.scrollTop = 0; fireEvent.scroll(list);
  await waitFor(() => expect(ids()[0]).toBe(10_015));
  expect(ids()).toEqual(Array.from({ length: 10_015 }, (_, i) => 10_015 - i));
  expect(within(list).getByRole('option', { selected: true }).textContent).toContain('Record 9500');
  expect(screen.getByText('Detail 9500')).toBeTruthy();

  // At the top, each arrival shows at once.
  add(3); await act(async () => change());
  await waitFor(() => expect(ids()[0]).toBe(10_018));
});
