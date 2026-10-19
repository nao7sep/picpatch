// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { sourceDrop } from '../../src/renderer/source-drop.ts';
function drop(target: HTMLElement, names: string[], type = 'drop') {
  const data = new DataTransfer();
  // happy-dom exposes file MIME types here; Chromium exposes the Files sentinel.
  Object.defineProperty(data, 'types', { get: () => ['Files'] });
  names.forEach(name => data.items.add(new File(['fixture'], name, { type: 'image/png' })));
  const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }); Object.defineProperty(event, 'dataTransfer', { value: data }); target.dispatchEvent(event); return event;
}
it('imports only into the source receiver, rejects multiple files, and clears its cue', async () => {
  const receiver = document.createElement('div'); const outside = document.createElement('button'); document.body.append(receiver, outside);
  const imported = vi.fn(async (_file: File) => {}); const report = vi.fn(); sourceDrop(receiver, imported, report);
  drop(receiver, ['a.png'], 'dragover'); expect(receiver.classList.contains('dropTarget')).toBe(true);
  expect(drop(outside, ['a.png']).defaultPrevented).toBe(true); expect(imported).not.toHaveBeenCalled(); expect(receiver.classList.contains('dropTarget')).toBe(false);
  drop(receiver, ['a.png', 'b.png']); expect(imported).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledOnce();
  drop(receiver, ['a.png']); expect(imported).toHaveBeenCalledOnce(); expect(imported.mock.calls[0]?.[0]).toMatchObject({ name: 'a.png' });
  receiver.remove(); outside.remove();
});
it('reports import rejection and leaves ordinary text drops native', async () => {
  const receiver = document.createElement('div'); const text = document.createElement('textarea'); document.body.append(receiver, text);
  const report = vi.fn(); sourceDrop(receiver, async () => { throw new Error('Import failed'); }, report);
  drop(receiver, ['a.png']); await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  const data = new DataTransfer(); data.setData('text/uri-list', 'https://example.test/');
  const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }); Object.defineProperty(event, 'dataTransfer', { value: data }); text.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
  receiver.remove(); text.remove();
});
it('clears hover and refuses drops behind a modal or a closing workspace', () => {
  const workspace = document.createElement('div'); const receiver = document.createElement('div'); workspace.append(receiver); document.body.append(workspace);
  const imported = vi.fn(async () => {}); sourceDrop(receiver, imported, vi.fn());
  drop(receiver,['a.png'],'dragover'); expect(receiver.classList.contains('dropTarget')).toBe(true);
  const dialog = document.createElement('dialog'); dialog.setAttribute('open',''); document.body.append(dialog);
  drop(receiver,['a.png'],'dragover'); expect(receiver.classList.contains('dropTarget')).toBe(false);
  drop(receiver,['a.png']); expect(imported).not.toHaveBeenCalled(); dialog.remove();
  workspace.setAttribute('inert',''); drop(receiver,['a.png']); expect(imported).not.toHaveBeenCalled();
  workspace.removeAttribute('inert'); drop(receiver,['a.png'],'dragover'); window.dispatchEvent(new Event('blur'));
  expect(receiver.classList.contains('dropTarget')).toBe(false); workspace.remove();
});
