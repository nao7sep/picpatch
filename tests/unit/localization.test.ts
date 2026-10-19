import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { catalogues, languages, resolveLocale, useLocale, t, UiError, errorText, errorNotice, number } from '../../src/shared/i18n/index.ts';
const literalKeys = ['component.clipL','component.clipG','component.t5','ui.vae','ui.photomaker','ui.ipadapter','ui.controlnet','component.vae','component.photoMaker','component.ipAdapter','component.controlNet'];
const identical: Record<string, string[]> = {
  de: ['logs.info','control.pose','shortcuts.navigation','ui.prompt','ui.seed','ui.zoom','ui.system','settings.system','parameter.sampler','parameter.scheduler','conditioning.prompt','component.checkpoint'],
  fr: ['conversation.image','control.pose','shortcuts.navigation','ui.sessions','ui.zoom','role.style','native.services'],
  es: ['logs.error','control.pose',], ja: [], ko: [], 'zh-Hans': [],
  it: ['logs.debug','run.summary','ui.prompt','ui.seed','ui.zoom','ui.checkpoint','ui.file','conditioning.prompt','component.checkpoint'],
  'pt-BR': ['control.pose','ui.prompt','ui.zoom','ui.checkpoint','conditioning.prompt','component.checkpoint'], ru: [],
};
it('ships independently reviewed catalogues with matching keys, placeholders, punctuation and intentional literals', async () => {
  const en = await catalogues.en();
  const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();
  for (const [tag] of languages) {
    const values = await catalogues[tag]();
    expect(Object.keys(values).sort(), tag).toEqual(Object.keys(en).sort());
    const raw = await readFile(new URL(`../../src/shared/i18n/locales/${tag}.json`, import.meta.url), 'utf8');
    expect(raw, tag).not.toMatch(/[\u00a0\u00ad\u200b-\u200f\u202f\ufeff]/);
    for (const [key, entry] of Object.entries(values)) {
      const sourceEntry = en[key as keyof typeof en];
      const source = typeof sourceEntry === 'string' ? sourceEntry : sourceEntry.other;
      if (typeof entry !== 'string') expect(Object.keys(entry).sort(), `${tag}:${key}`).toEqual(new Intl.PluralRules(tag).resolvedOptions().pluralCategories.sort());
      for (const text of typeof entry === 'string' ? [entry] : Object.values(entry)) {
        expect(text, `${tag}:${key}`).toBe(text.trim()); expect(text.length).toBeGreaterThan(0);
        expect(placeholders(text), `${tag}:${key}`).toEqual(placeholders(source));
        expect(text.includes('…'), `${tag}:${key}`).toBe(source.includes('…')); expect(text).not.toMatch(/\.\.\.| …/);
        if (tag !== 'en' && /[A-Za-z]/.test(text.replace(/\{\w+\}|GB/g, '')) && !literalKeys.includes(key) && !identical[tag]?.includes(key)) expect(text, `${tag}:${key}`).not.toBe(source);
      }
    }
    for (const key of [...literalKeys, ...(identical[tag] ?? [])]) if (tag !== 'en') expect(values[key as keyof typeof en], `${tag}:${key} stale equality exception`).toBe(en[key as keyof typeof en]);
  }
});
it('resolves System in preference order, normalizes regional variants and keeps formatting regional only within the interface language', () => {
  expect(resolveLocale(undefined, ['ar','zh-TW','ja'], 'ja-JP')).toEqual({language:'zh-Hans',format:'zh-Hans'});
  expect(resolveLocale('unknown',['pt-PT'], 'pt-PT')).toEqual({language:'pt-BR',format:'pt-PT'});
  expect(resolveLocale('ja',['de'], 'en-US')).toEqual({language:'ja',format:'ja'});
  expect(resolveLocale(undefined,['ar'], 'en-GB')).toEqual({language:'en',format:'en-GB'});
});
it('renders retained errors and nested values in the current language without translating raw user content', async () => {
  const error = new UiError('ui.choose_completed_results'); const englishMessage = error.message;
  try {
    await useLocale({ language:'ja',format:'ja' }); expect(errorText(error)).not.toBe(englishMessage); expect(error.message).toBe(englishMessage);
    expect(t('common.detail', {status:{key:'status.failed'},detail:'user-authored prompt'})).toContain('user-authored prompt');
    expect(errorText(new Error('/private/runtime failed with secret detail'))).toBe(t('ui.the_operation_could_not_finish'));
    expect(errorText({ code: 'CANCELLED', message: 'private runtime path' })).toBe(t('status.cancelled'));
    const transported = { notice: errorNotice(new Error('Select a completed image.')) };
    await useLocale({language:'de',format:'de-DE'});
    expect(errorText(transported)).toBe(errorText(new Error('Select a completed image.')));
    expect(number(1234.5)).toBe('1.234,5');
  } finally { await useLocale({language:'en',format:'en'}); }
});

it('does not apply a stale asynchronous locale after a later choice', async () => {
  await useLocale({language:'en',format:'en'});
  const earlier = useLocale({language:'ja',format:'ja'});
  await useLocale({language:'en',format:'en'}); await earlier;
  expect(t('ui.settings')).toBe('Settings');
});
