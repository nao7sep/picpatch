// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logsView } from '../../src/renderer/logs.ts';
import type { LogsBridge } from '../../src/shared/logs-bridge.ts';
let dispose: () => void; let api: LogsBridge; let changed: () => void;
const row = { id: 30, session: '2026-10-19T00:00:00Z', time: '2026-10-19T01:00:00Z', level: 'warn' as const, message: '<img src=x> Literal diagnostic' };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
beforeEach(async () => {
  document.write((await readFile('src/renderer/logs.html','utf8')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link[^>]+>/g, ''));
  api = { query: vi.fn().mockResolvedValue({ records: [row], more: true }), detail: vi.fn().mockResolvedValue('{"literal":"ui.settings", "full":true}'), appearance: vi.fn().mockResolvedValue({ locale: { language: 'en', format: 'en' }, dark: true }), close: vi.fn().mockResolvedValue(undefined), onRecordsChanged: listener => { changed = listener; return vi.fn(); }, onAppearanceChanged: () => vi.fn() };
  dispose = logsView(api); await vi.waitFor(() => expect(el('logsList').children.length).toBe(1));
});
afterEach(() => { dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });
it('shows persistent summaries literally, selected full detail and theme', async () => {
  expect(el('logsList').textContent).toContain(row.message); expect(el('logsList').querySelector('img')).toBeNull();
  (el('logsList').firstElementChild as HTMLButtonElement).click();
  await vi.waitFor(() => expect(el('logsDetail').textContent).toContain('ui.settings'));
  expect(api.detail).toHaveBeenCalledWith(30); expect(document.documentElement.style.colorScheme).toBe('dark');
});
it('queries filters and one bounded next page; new events only offer refresh', async () => {
  changed(); changed(); expect(api.query).toHaveBeenCalledTimes(1); expect(el('logsStatus').textContent).toContain('New records');
  el<HTMLSelectElement>('launch').value = 'all'; el('launch').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(api.query).toHaveBeenLastCalledWith({ current: false, level: 'all', search: '' }));
  el('older').click(); await vi.waitFor(() => expect(api.query).toHaveBeenLastCalledWith({ current: false, level: 'all', search: '', before: 30 }));
  expect(el('logsList').children.length).toBe(1);
});
it('keeps failures visible without automatic retry or record feedback loops', async () => {
  vi.mocked(api.query).mockRejectedValueOnce(new Error('private path'));
  el('newest').click(); await vi.waitFor(() => expect(el('logsIssue').hidden).toBe(false));
  changed(); changed(); expect(api.query).toHaveBeenCalledTimes(2); expect(el('logsIssue').textContent).not.toContain('private path');
  el('newest').click(); await vi.waitFor(() => expect(el('logsIssue').hidden).toBe(true));
});
it('discards stale detail after a filter change and supports keyboard selection', async () => {
  let resolve!: (value: string) => void;
  vi.mocked(api.detail).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const first = el('logsList').firstElementChild as HTMLButtonElement; first.focus(); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(api.detail).toHaveBeenCalledWith(30);
  el('newest').click(); resolve('stale'); await Promise.resolve();
  expect(el('logsDetail').textContent).not.toBe('stale');
});
