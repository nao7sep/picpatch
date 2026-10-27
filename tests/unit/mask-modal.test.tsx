// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaskModal } from '../../src/renderer/src/modals/MaskModal.tsx';
import { fakeBridge } from '../helpers/bridge.ts';

class ImageSource {
  naturalWidth = 2000;
  naturalHeight = 1000;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}

beforeEach(() => {
  window.picpatch = fakeBridge().bridge;
  vi.stubGlobal('Image', ImageSource);
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: 600, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders one fitted source/overlay frame with original pixel dimensions', async () => {
  const view = render(<MaskModal source="source" mask={undefined} note="" onClose={vi.fn()} onDone={async () => undefined} confirmDiscard={async () => true} onDirty={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelector('.mask-frame')).not.toBeNull());
  const frame = view.container.querySelector<HTMLElement>('.mask-frame')!;
  expect([frame.style.width, frame.style.height]).toEqual(['600px', '300px']);
  expect(frame.querySelector('img')!.parentElement).toBe(frame);
  const canvas = frame.querySelector('canvas')!;
  expect([canvas.width, canvas.height]).toEqual([2000, 1000]);
  const css = readFileSync('src/renderer/src/styles/app.css', 'utf8');
  expect(css).toContain('.mask-frame { position: relative; flex: none; }');
  expect(css).toContain('.mask-frame img, .mask-frame canvas { position: absolute; inset: 0; width: 100%; height: 100%; }');
});
