import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { catalogues, languages, resolveLocale, useLocale, t, UiError, errorText, errorNotice, number } from '../../src/shared/i18n/index.ts';
const literalKeys = ['component.clipL','component.clipG','component.t5','component.vae','component.photoMaker','component.ipAdapter','component.controlNet','conversation.size'];
const identical: Record<string, string[]> = {
  de: ['ui.seed','settings.system','parameter.sampler','parameter.scheduler','conditioning.prompt','component.checkpoint','control.pose','logs.info','setup.size','about.version','model.download','purpose.illustration','purpose.design','purpose.inpainting','purpose.outpainting'],
  fr: ['ui.sessions','role.style','native.services','control.pose','conversation.image','menu.open','logs.action','logs.session','logs.message','about.version','composer.portrait','conversation.count','conversation.label','rail.meta','reference.photos','purpose.illustration','purpose.design'],
  es: ['control.pose','logs.error','settings.general'], ja: [], ko: [], 'zh-Hans': [],
  it: ['ui.seed','ui.file','conditioning.prompt','component.checkpoint','logs.debug','menu.open','about.repository','setup.size','model.download','purpose.design'],
  'pt-BR': ['conditioning.prompt','component.checkpoint','control.pose','menu.open','setup.size','model.download','purpose.design'], ru: [],
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
    const other = (entry: unknown) => typeof entry === 'string' ? entry : (entry as Record<string, string>).other;
    for (const key of [...literalKeys, ...(identical[tag] ?? [])]) if (tag !== 'en') expect(other(values[key as keyof typeof en]), `${tag}:${key} stale equality exception`).toBe(other(en[key as keyof typeof en]));
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
    expect(t('conversation.edited', { name: 'user-authored prompt' })).toContain('user-authored prompt');
    expect(t('run.paused', { reason: { key: 'status.failed' } })).toContain(t('status.failed'));
    expect(errorText(new Error('/private/runtime failed with secret detail'))).toBe(t('error.unknown'));
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

it('maps real SDK errors by cause and keeps hostile text out of operation fallbacks', async () => {
  const { PicPatchSdkError } = await import('picpatchsdk');
  for (const [code, key] of [['OUT_OF_MEMORY','error.memory'], ['ENGINE_MISSING','error.engine'], ['INVALID_IMAGE','error.input'],
    ['MODEL_MISSING','error.prepare_this_model_in_managed_models_before_running_it'], ['MODEL_MISMATCH','error.model_files'], ['MODEL_CHANGED','error.model_files'],
    ['MODEL_REMOVAL_INCOMPLETE','error.model_removal'], ['MODEL_IO','error.storage'], ['RECORD_IO','error.storage']] as const) {
    const error = new PicPatchSdkError(code, 'TypeError EACCES /private/SENTINEL');
    expect(errorNotice(error).key).toBe(key);
    expect(errorText(error)).not.toContain('SENTINEL');
  }
  // Refusals carry the SDK's codes too: a newer saved format and an incomplete model each get their own copy.
  for (const [code, key] of [['MODEL_INCOMPLETE','error.prepare_this_model_in_managed_models_before_running_it'], ['MODEL_REGISTRATION_VERSION_UNSUPPORTED','error.newer_format'], ['ARTIFACT_VERSION_UNSUPPORTED','error.newer_format']] as const)
    expect(errorNotice({ status: 'refused', code, message: 'SENTINEL', details: {} }).key).toBe(key);
  expect(errorNotice(new Error('Select a completed image.'), 'error.generate').key).toBe('error.generate');
  expect(errorNotice(new UiError('error.select_a_completed_image')).key).toBe('error.select_a_completed_image');
});
it('names About the way each language names it in macOS menus', async () => {
  const expected = { en: 'About PicPatch', de: 'Über PicPatch', es: 'Acerca de PicPatch', fr: 'À propos de PicPatch', it: 'Informazioni su PicPatch', ja: 'PicPatch について', ko: 'PicPatch에 관하여', 'pt-BR': 'Sobre o PicPatch', ru: 'О программе PicPatch', 'zh-Hans': '关于 PicPatch' };
  for (const [language, label] of Object.entries(expected)) {
    const catalogue = JSON.parse(await readFile(new URL(`../../src/shared/i18n/locales/${language}.json`, import.meta.url), 'utf8'));
    expect(catalogue['ui.about_picpatch'], language).toBe(label);
  }
});
