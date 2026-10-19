import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));
import { startupFailureHtml } from '../../src/main/startup-failure.ts';
it('offers localized recovery without raw error text, script or workspace authority', () => {
  const html = startupFailureHtml(new Error('<img src=x onerror=bad()>'), true);
  expect(html).toContain('color-scheme:dark'); expect(html).toContain('https://picpatch.invalid/retry');
  expect(html).not.toContain('onerror'); expect(html).not.toContain('<script'); expect(html).not.toContain('<img');
  expect(html).toContain('default-src');
});
