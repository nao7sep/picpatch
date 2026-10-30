import { expect, it } from 'vitest';
import { checkNumber } from '../../src/renderer/src/number-field.tsx';
import { validateDraft } from '../../src/main/core/sessions.ts';
import { initialDraft } from '../../src/shared/session.ts';

it('reads typed text as the number it stands for, or says what the field accepts', () => {
  const seed = { whole: true, min: 0, max: 4294967295, empty: true };
  expect(checkNumber('', seed)).toEqual({ value: undefined });
  expect(checkNumber(' 42 ', seed)).toEqual({ value: 42 });
  expect(checkNumber('007', seed)).toEqual({ value: 7 });
  for (const typed of ['1.5', '-1', '4294967296', 'abc', '4e', '0x10', 'Infinity', '1,000']) expect(checkNumber(typed, seed), typed).toEqual({ error: { key: 'field.whole_range', values: { min: 0, max: 4294967295 } } });
  expect(checkNumber('', { whole: true, min: 1, max: 100 })).toEqual({ error: { key: 'field.whole_range', values: { min: 1, max: 100 } } });
  expect(checkNumber('0.25', { min: 0, empty: true })).toEqual({ value: 0.25 });
  expect(checkNumber('-0.5', { min: 0, empty: true })).toEqual({ error: { key: 'field.number_min', values: { min: 0 } } });
  expect(checkNumber('-0.5', { empty: true })).toEqual({ value: -0.5 });
  expect(checkNumber('x', { empty: true })).toEqual({ error: { key: 'field.number' } });
  expect(checkNumber('1e3', { whole: true, min: 1 })).toEqual({ value: 1000 });
  // A maximum too large to read out is still checked.
  expect(checkNumber('4e38', { min: 0, max: 3.4e38 })).toEqual({ error: { key: 'field.number_min', values: { min: 0 } } });
});

it('takes whole multiples of the size step, at least one step, and nothing else', () => {
  const size = { whole: true, multiple: 16 };
  expect(checkNumber('832', size)).toEqual({ value: 832 });
  for (const typed of ['0', '8', '830', '832.5', '']) expect(checkNumber(typed, size), typed).toEqual({ error: { key: 'field.multiple', values: { multiple: 16 } } });
});

it('refuses, rather than corrects, a draft value outside the ranges the fields accept', () => {
  expect(() => validateDraft({ ...initialDraft(), seed: 2 ** 32 })).toThrow();
  expect(validateDraft({ ...initialDraft(), seed: 2 ** 32 - 1 }).seed).toBe(2 ** 32 - 1);
  expect(() => validateDraft({ ...initialDraft(), control: { image: '11111111-1111-4111-8111-111111111111', kind: 'canny', strength: -1 } })).toThrow();
  expect(() => validateDraft({ ...initialDraft(), outpaint: { width: 10.5, height: 10, left: 0, top: 0 } })).toThrow();
  expect(() => validateDraft({ ...initialDraft(), outpaint: { width: 10, height: 10, left: -1, top: 0 } })).toThrow();
});
