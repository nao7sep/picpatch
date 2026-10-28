// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Conversation } from '../../src/renderer/src/components/Conversation.tsx';
import { run, session } from '../helpers/bridge.ts';
import { setCatalog } from '../../src/renderer/src/models.ts';
import { models } from '../helpers/bridge.ts';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('uses monotonic progress anchors while the wall clock moves both directions', async () => {
  vi.useFakeTimers(); let monotonic = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const current = session({ runs: [run('running', { status: 'running', output: undefined })] });
  const active = { runId: 'running', sessionId: current.id, stage: 'generating', startedAt: 1_000_000, elapsedMs: 5000 };
  const props = { session: current, queue: { paused: false, active }, target: undefined, optionsPane: false, saved: undefined, onRename() {}, onToggleOptions() {}, onEditThis() {}, onReuse() {}, onView() {}, onSave() {}, onCancel() {} };
  const view = render(<Conversation {...props} />);
  expect(screen.getByText('0:05')).toBeTruthy();
  clock.mockReturnValue(9_000_000); monotonic += 1000;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText('0:06')).toBeTruthy();
  clock.mockReturnValue(0); monotonic += 1000;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.getByText('0:07')).toBeTruthy();
  view.rerender(<Conversation {...props} queue={{ paused: false, active: { ...active, elapsedMs: 8000 } }} />);
  expect(screen.getByText('0:08')).toBeTruthy();
});

it('describes masked composite output by source size rather than the inactive generation dimensions', () => {
  setCatalog(models as never);
  const draft = { ...session().draft, mode: 'edit' as const, source: 'input', mask: 'mask', width: 832, height: 1216 };
  const current = session({ runs: [run('queued', { draft, status: 'queued', output: undefined })] });
  render(<Conversation session={current} queue={{ paused: false }} target={undefined} optionsPane={false} saved={undefined} onRename={() => {}} onToggleOptions={() => {}} onEditThis={() => {}} onReuse={() => {}} onView={() => {}} onSave={() => {}} onCancel={() => {}} />);
  expect(screen.getByText('Source image size')).toBeTruthy();
  expect(document.querySelector<HTMLElement>('.developing')!.style.aspectRatio).toBe('');
});
