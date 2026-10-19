// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('lists records literally, shows the selected record and offers new records without refreshing', async () => {
  const { api, change } = bridge();
  render(<RecordsWindow api={api} />);
  expect(await screen.findByText('<b>Literal</b>')).toBeTruthy();
  expect(document.querySelector('.pill.level-error')!.textContent).toBe('Error');
  fireEvent.click(screen.getByText('Second'));
  expect(await screen.findByText('Detail 2')).toBeTruthy();
  await act(async () => change());
  expect(screen.getByText('New records are available.')).toBeTruthy();
  expect(api.query).toHaveBeenCalledTimes(1);
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

it('keeps a failed read visible until Refresh is chosen', async () => {
  const query = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue({ records: [row(5, 'Back')], more: false });
  const { api } = bridge({ query });
  render(<RecordsWindow api={api} />);
  expect(await screen.findByText('Records could not be read. Try Refresh again.')).toBeTruthy();
  expect(query).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Back')).toBeTruthy();
});
