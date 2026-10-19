// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { operationResults } from '../../src/renderer/operation-results.ts';
import { UiError } from '../../src/shared/i18n/index.ts';
it('retains independent failures, suppresses repeated announcements and respects dismissal', () => {
  const host = document.createElement('div'); const results = operationResults(host);
  const first = new UiError('ui.choose_completed_results');
  results.show('export', first); const row = host.firstChild;
  results.show('export', first); expect(host.firstChild).toBe(row);
  results.show('history', new UiError('ui.could_not_encode_mask')); expect(host.children).toHaveLength(2);
  results.clear('unrelated-success'); expect(host.children).toHaveLength(2);
  host.querySelector('button')!.click(); results.show('export', first); expect(host.children).toHaveLength(1);
  results.clear('export'); results.show('export', first); expect(host.children).toHaveLength(2);
  results.clear('history'); results.clear('export'); expect(host.hidden).toBe(true);
});
it('never exposes raw exception details', () => {
  const host = document.createElement('div'); operationResults(host).show('load', new Error('EACCES /private/internal SENTINEL'));
  expect(host.textContent).not.toMatch(/EACCES|private|SENTINEL/);
});
