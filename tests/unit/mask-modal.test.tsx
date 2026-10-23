// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaskModal } from '../../src/renderer/src/modals/MaskModal.tsx';
import type { MaskRequest } from '../../src/renderer/src/mask/worker.ts';
import { fakeBridge } from '../helpers/bridge.ts';

class ImageSource {
  naturalWidth = 2000;
  naturalHeight = 1000;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}
class MaskPort {
  static all: MaskPort[] = [];
  onmessage: Worker['onmessage'] = null;
  onerror = null;
  onmessageerror = null;
  terminate = vi.fn();
  requests: MaskRequest[] = [];
  constructor() { MaskPort.all.push(this); }
  postMessage(request: MaskRequest) {
    this.requests.push(request);
    if (request.command.kind !== 'encode') queueMicrotask(() => this.reply(request, undefined));
  }
  reply(request: MaskRequest, bytes?: Uint8Array) {
    this.onmessage?.call(this as unknown as Worker, { data: { id: request.id, result: { undo: true, redo: false, ...(bytes ? { bytes } : {}) } } } as MessageEvent);
  }
}

beforeEach(() => {
  window.picpatch = fakeBridge().bridge;
  MaskPort.all = [];
  vi.stubGlobal('Image', ImageSource);
  vi.stubGlobal('Worker', MaskPort);
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: 600, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: () => ({}) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (HTMLCanvasElement.prototype as Partial<HTMLCanvasElement>).transferControlToOffscreen; });

it('renders one fitted source/overlay frame with original pixel dimensions and survives strict effect replay', async () => {
  const view = render(<StrictMode><MaskModal source="source" mask={undefined} note="" onClose={vi.fn()} onDone={async () => undefined} confirmDiscard={async () => true} onDirty={vi.fn()} /></StrictMode>);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(false));
  const frame = view.container.querySelector<HTMLElement>('.mask-frame')!;
  expect([frame.style.width, frame.style.height]).toEqual(['600px', '300px']);
  expect(frame.querySelector('img')!.parentElement).toBe(frame);
  const canvas = frame.querySelector('canvas')!;
  expect([canvas.width, canvas.height]).toEqual([2000, 1000]);
  expect(frame.querySelectorAll('canvas')).toHaveLength(1);
  const css = readFileSync('src/renderer/src/styles/app.css', 'utf8');
  expect(css).toContain('.mask-frame { position: relative; flex: none; }');
  expect(css).toContain('.mask-frame img, .mask-frame canvas { position: absolute; inset: 0; width: 100%; height: 100%; }');
  view.unmount();
  await waitFor(() => expect(MaskPort.all.every(port => port.terminate.mock.calls.length === 1)).toBe(true));
});

it('guards all conflicting edits and close paths through encode and accepted-save settlement', async () => {
  let finish!: () => void;
  const onDone = vi.fn(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
  const onClose = vi.fn();
  let settled = false;
  const onAccepted = vi.fn((task: Promise<void>) => {
    expect(MaskPort.all.at(-1)!.requests.some(request => request.command.kind === 'encode')).toBe(false);
    void task.then(() => { settled = true; });
  });
  const view = render(<MaskModal source="source" mask={undefined} note="" onClose={onClose} onDone={onDone} onAccepted={onAccepted} confirmDiscard={async () => true} onDirty={vi.fn()} />);
  const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
  await waitFor(() => expect(done.disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Clear mask' }));
  fireEvent.click(done);
  expect(onAccepted).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  const worker = MaskPort.all.at(-1)!;
  await waitFor(() => expect(worker.requests.at(-1)!.command.kind).toBe('encode'));
  expect(done.disabled).toBe(true);
  fireEvent.click(done);
  expect(onAccepted).toHaveBeenCalledOnce();
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Clear mask' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => worker.reply(worker.requests.at(-1)!, new Uint8Array([1, 2])));
  expect(onDone).toHaveBeenCalledWith(new Uint8Array([1, 2]));
  expect(done.disabled).toBe(true);
  expect(settled).toBe(false);
  await act(async () => finish());
  expect(settled).toBe(true);
  expect(onDone).toHaveBeenCalledOnce();
  expect(done.disabled).toBe(false);
  view.unmount();
  await waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
});

it('keeps a detached worker owned until its in-flight encode reply settles', async () => {
  const onDone = vi.fn(async () => undefined);
  const view = render(<MaskModal source="source" mask={undefined} note="" onClose={vi.fn()} onDone={onDone} confirmDiscard={async () => true} onDirty={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Clear mask' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  const worker = MaskPort.all.at(-1)!;
  await waitFor(() => expect(worker.requests.at(-1)!.command.kind).toBe('encode'));
  view.unmount();
  expect(worker.terminate).not.toHaveBeenCalled();
  await act(async () => worker.reply(worker.requests.at(-1)!, new Uint8Array([7])));
  expect(onDone).toHaveBeenCalledWith(new Uint8Array([7]));
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects accepted work on save refusal while keeping the draft open for a distinct retry', async () => {
  const accepted: Promise<void>[] = [];
  const onDone = vi.fn<() => Promise<string | undefined>>(async () => 'The mask could not be saved.');
  const onClose = vi.fn();
  render(<MaskModal source="source" mask={undefined} note="" onClose={onClose} onDone={onDone} onAccepted={task => { accepted.push(task); void task.catch(() => {}); }} confirmDiscard={async () => true} onDirty={vi.fn()} />);
  const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
  await waitFor(() => expect(done.disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Clear mask' }));
  fireEvent.click(done);
  const worker = MaskPort.all.at(-1)!;
  const rejection = expect(accepted[0]).rejects.toThrow('The mask could not be saved.');
  await act(async () => worker.reply(worker.requests.at(-1)!, new Uint8Array([1])));
  await rejection;
  expect(screen.getByRole('alert').textContent).toBe('The mask could not be saved.');
  expect(onClose).not.toHaveBeenCalled();
  expect(done.disabled).toBe(false);
  // Observing the same rejected accepted task does not repeat encoding or save.
  await expect(accepted[0]).rejects.toThrow('The mask could not be saved.');
  expect(onDone).toHaveBeenCalledOnce();
  onDone.mockResolvedValueOnce(undefined);
  fireEvent.click(done);
  expect(accepted).toHaveLength(2);
  await act(async () => worker.reply(worker.requests.at(-1)!, new Uint8Array([2])));
  await expect(accepted[1]).resolves.toBeUndefined();
  expect(onDone).toHaveBeenCalledTimes(2);
});

it('rejects the accepted encoding task while presenting safe failure copy', async () => {
  let task!: Promise<void>;
  const onDone = vi.fn(async () => undefined);
  render(<MaskModal source="source" mask={undefined} note="" onClose={vi.fn()} onDone={onDone} onAccepted={value => { task = value; void value.catch(() => {}); }} confirmDiscard={async () => true} onDirty={vi.fn()} />);
  const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
  await waitFor(() => expect(done.disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Clear mask' }));
  fireEvent.click(done);
  const worker = MaskPort.all.at(-1)!;
  const diagnostic = 'DOMException ENCODE_FAILED /private/mask.png sentinel';
  const rejection = expect(task).rejects.toThrow(diagnostic);
  await act(async () => worker.onmessage?.call(worker as unknown as Worker, { data: { id: worker.requests.at(-1)!.id, error: { message: diagnostic } } } as MessageEvent));
  await rejection;
  const copy = screen.getByRole('alert').textContent!;
  expect(copy).toBe('Could not encode mask.');
  expect(copy).not.toContain('sentinel');
  expect(onDone).not.toHaveBeenCalled();
  expect(done.disabled).toBe(false);
});
