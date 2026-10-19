// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { renderCollection } from '../../src/renderer/collection.ts';
const entries = () => ['a', 'b', 'c'].map(key => ({ key, label: key, element: document.createElement('button') }));
it('separates keyboard focus from activation and preserves focus through background rendering', () => {
  const holder = document.createElement('div'); document.body.append(holder); const select = vi.fn();
  const options = { label: 'Items', selected: ['a'], empty: 'Empty', select };
  renderCollection(holder, entries(), options);
  const first = holder.children[0] as HTMLElement; first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect((document.activeElement as HTMLElement).dataset.key).toBe('b'); expect(select).not.toHaveBeenCalled();
  renderCollection(holder, entries(), options);
  expect((document.activeElement as HTMLElement).dataset.key).toBe('b');
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); expect(select).toHaveBeenLastCalledWith(['b']);
  renderCollection(holder, [], options); expect(document.activeElement).toBe(holder); expect(holder.textContent).toBe('Empty'); holder.remove();
});
it('supports toggle and range selection without activating hovered items', () => {
  const holder = document.createElement('div'); document.body.append(holder); const select = vi.fn();
  renderCollection(holder, entries(), { label: 'Images', selected: [], empty: 'Empty', multiple: true, select });
  (holder.children[0] as HTMLElement).click();
  holder.children[2]!.dispatchEvent(new MouseEvent('click', { shiftKey: true })); expect(select).toHaveBeenLastCalledWith(['a', 'b', 'c']);
  holder.children[1]!.dispatchEvent(new MouseEvent('click', { ctrlKey: true })); expect(select).toHaveBeenLastCalledWith(['a', 'c']);
  holder.children[0]!.dispatchEvent(new MouseEvent('mouseover')); expect((document.activeElement as HTMLElement).dataset.key).toBe('b'); holder.remove();
});

it('recovers to the neighboring item and ignores composition navigation', () => {
  const holder = document.createElement('div'); document.body.append(holder); const select = vi.fn();
  const options = { label: 'Items', selected: [], empty: 'Empty', select };
  renderCollection(holder, entries(), options); (holder.children[1] as HTMLElement).focus();
  holder.children[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })); expect(select).not.toHaveBeenCalled();
  renderCollection(holder, entries().filter(item => item.key !== 'b'), options);
  expect((document.activeElement as HTMLElement).dataset.key).toBe('c'); holder.remove();
});
