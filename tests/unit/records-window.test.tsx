// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecordsWindow } from '../../src/renderer/src/records/RecordsWindow.tsx';
import type { LogsBridge } from '../../src/shared/logs-bridge.ts';
import type { RecordSummary } from '../../src/shared/records.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
afterEach(cleanup);

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
  await waitFor(() => expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringContaining('Arrived'), expect.stringContaining('Literal'), expect.stringContaining('Second')]));
  expect(within(list).getByRole('option', { selected: true }).textContent).toContain('Second');
  expect(screen.getByText('Detail 2')).toBeTruthy();
});

it('holds new records while the list is scrolled away and adds them on return to the top', async () => {
  let newest = 3;
  const { api, change } = bridge({ query: vi.fn(async query => ({ records: query.before ? [] : [...(newest > 3 ? [row(4, 'Arrived')] : []), row(3, 'Third'), row(2, 'Second')], more: false })) });
  render(<RecordsWindow api={api} />);
  await screen.findByText('Third');
  const list = screen.getByRole('listbox', { name: 'Records' });
  list.scrollTop = 200; newest = 4;
  await act(async () => change());
  expect(screen.getByText('New records are available.')).toBeTruthy(); expect(screen.queryByText('Arrived')).toBeNull();
  list.scrollTop = 0; fireEvent.scroll(list);
  expect(await screen.findByText('Arrived')).toBeTruthy();
  expect(screen.queryByText('New records are available.')).toBeNull();
});

it('moves the splitter 16 px per arrow press, reaches its bounds with Home and End, and saves once on release', async () => {
  const { api } = bridge();
  render(<RecordsWindow api={api} />);
  await screen.findByText('Second');
  const splitter = screen.getByRole('separator');
  const start = Number(splitter.getAttribute('aria-valuenow'));
  for (let i = 0; i < 3; i++) fireEvent.keyDown(splitter, { key: 'ArrowRight' });
  expect(Number(splitter.getAttribute('aria-valuenow'))).toBe(start + 48); expect(api.resizeList).not.toHaveBeenCalled();
  fireEvent.keyUp(splitter, { key: 'ArrowRight' });
  await waitFor(() => expect(api.resizeList).toHaveBeenCalledTimes(1)); expect(api.resizeList).toHaveBeenLastCalledWith(start + 48);
  fireEvent.keyDown(splitter, { key: 'End' });
  expect(splitter.getAttribute('aria-valuenow')).toBe(splitter.getAttribute('aria-valuemax'));
  fireEvent.keyDown(splitter, { key: 'Home' }); fireEvent.blur(splitter);
  await waitFor(() => expect(api.resizeList).toHaveBeenLastCalledWith(320)); expect(api.resizeList).toHaveBeenCalledTimes(2);
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

it('keeps a failed read visible until the next record arrives, then reads again', async () => {
  const query = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue({ records: [row(5, 'Back')], more: false });
  const { api, change } = bridge({ query });
  render(<RecordsWindow api={api} />);
  expect(await screen.findByText('Records could not be read.')).toBeTruthy();
  expect(query).toHaveBeenCalledTimes(1);
  await act(async () => change());
  expect(await screen.findByText('Back')).toBeTruthy();
});
