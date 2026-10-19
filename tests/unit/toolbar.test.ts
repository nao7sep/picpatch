// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { toolbar } from '../../src/renderer/toolbar.ts';
afterEach(() => { window.dispatchEvent(new Event('pagehide')); document.body.replaceChildren(); });
function setup() {
  document.body.innerHTML = '<div role="toolbar"><button>A</button><button disabled>B</button><button>C</button><button hidden>D</button></div><input type="range"><select><option>A</option><option>B</option></select>';
  const holder = document.querySelector('div')!; toolbar(holder);
  const buttons = [...holder.querySelectorAll('button')];
  const press = (key: string, options: KeyboardEventInit = {}) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  return { holder, buttons, press };
}
it('provides one tab stop, skips unavailable actions, remembers focus and never activates by navigation', () => {
  const { holder, buttons, press } = setup(); const click = vi.fn(); holder.addEventListener('click', click);
  expect(buttons.map(b => b.tabIndex)).toEqual([0,-1,-1,-1]); buttons[0]!.focus(); press('ArrowRight');
  expect(document.activeElement).toBe(buttons[2]); expect(buttons.map(b => b.tabIndex)).toEqual([-1,-1,0,-1]);
  expect(press('Tab')).toBe(true); document.querySelector('input')!.focus();
  expect(buttons[2]!.tabIndex).toBe(0); buttons[2]!.focus(); press('Home'); expect(document.activeElement).toBe(buttons[0]);
  press('End'); expect(document.activeElement).toBe(buttons[2]); expect(click).not.toHaveBeenCalled();
});
it('preserves native range/select keys and ignores composition and modified arrows', () => {
  const { buttons, press } = setup(); buttons[0]!.focus(); press('ArrowRight', { keyCode: 229 }); press('End', { ctrlKey: true });
  expect(document.activeElement).toBe(buttons[0]);
  for (const selector of ['input','select']) { const control = document.querySelector<HTMLElement>(selector)!; control.focus(); expect(press('ArrowRight')).toBe(true); expect(press('Home')).toBe(true); expect(document.activeElement).toBe(control); }
});
it('recovers the active position after disabling or hiding actions without stealing outside focus', async () => {
  const { holder, buttons, press } = setup(); buttons[0]!.focus(); press('End');
  buttons[2]!.blur(); buttons[2]!.hidden = true; await vi.waitFor(() => expect(buttons[0]!.tabIndex).toBe(0)); expect(document.activeElement).toBe(buttons[0]);
  const outside = document.querySelector('input')!; outside.focus(); buttons[0]!.disabled = true;
  await vi.waitFor(() => expect(holder.tabIndex).toBe(0)); expect(document.activeElement).toBe(outside);
  buttons[1]!.disabled = false; await vi.waitFor(() => expect(buttons[1]!.tabIndex).toBe(0)); expect(document.activeElement).toBe(outside);
});
