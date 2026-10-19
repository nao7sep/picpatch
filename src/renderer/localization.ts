import { t, useLocale, languages, term, activeLocale } from '../shared/i18n/index.ts';
import type { Locale } from '../shared/i18n/index.ts';
export async function localize(locale: Locale): Promise<boolean> {
  const changed = await useLocale(locale);
  if (activeLocale().language !== locale.language || activeLocale().format !== locale.format) return false;
  if (!changed && !document.body.hidden && document.documentElement.lang === locale.language) return false;
  document.documentElement.lang = locale.language;
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) element.textContent = t(element.dataset.i18n!);
  for (const attribute of ['placeholder', 'aria-label', 'alt', 'title']) {
    for (const element of document.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)!));
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-component-clear]')) element.setAttribute('aria-label', t('management.clear', { name: term('component', element.dataset.componentClear!) }));
  document.body.hidden = false;
  return changed;
}
export function languageOptions(select: HTMLSelectElement, systemLanguage: string) {
  const selected = select.value; select.replaceChildren();
  const system = document.createElement('option'); system.value = 'system'; system.textContent = t('settings.system', { value: new Intl.DisplayNames([document.documentElement.lang], { type: 'language' }).of(systemLanguage) ?? systemLanguage }); select.append(system);
  for (const [tag, name] of languages) { const option = document.createElement('option'); option.value = tag; option.lang = tag; option.textContent = name; select.append(option); }
  select.value = selected || 'system';
}
