import english from './locales/en.json' with { type: 'json' };
export const languages = [ ['de', 'Deutsch'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano'], ['pt-BR', 'Português'], ['ru', 'Русский'], ['zh-Hans', '中文'], ['ja', '日本語'], ['ko', '한국어'] ] as const;
export type Language = typeof languages[number][0];
export type Key = keyof typeof english;
export type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalogue = Record<Key, Entry>;
export interface Message { key: string; values?: Record<string, string | number | Message> }
export interface Locale { language: Language; format: string }
const loaders = {
  en: async () => english,
  de: async () => (await import('./locales/de.json', { with: { type: 'json' } })).default,
  es: async () => (await import('./locales/es.json', { with: { type: 'json' } })).default,
  fr: async () => (await import('./locales/fr.json', { with: { type: 'json' } })).default,
  it: async () => (await import('./locales/it.json', { with: { type: 'json' } })).default,
  'pt-BR': async () => (await import('./locales/pt-BR.json', { with: { type: 'json' } })).default,
  ru: async () => (await import('./locales/ru.json', { with: { type: 'json' } })).default,
  'zh-Hans': async () => (await import('./locales/zh-Hans.json', { with: { type: 'json' } })).default,
  ja: async () => (await import('./locales/ja.json', { with: { type: 'json' } })).default,
  ko: async () => (await import('./locales/ko.json', { with: { type: 'json' } })).default,
} satisfies Record<Language, () => Promise<Catalogue>>;
export const catalogues = loaders;
export function preference(value: unknown): Language | undefined { return languages.some(([tag]) => tag === value) ? value as Language : undefined; }
function supported(value: string): Language | undefined {
  const base = value.toLowerCase().split(/[-_]/)[0];
  return base === 'zh' ? 'zh-Hans' : base === 'pt' ? 'pt-BR' : preference(base);
}
export function resolveLocale(choice: unknown, system: readonly string[], regional: string): Locale {
  const language = preference(choice) ?? system.map(supported).find(Boolean) ?? 'en';
  return { language, format: supported(regional) === language ? regional : language };
}
let current: Locale = { language: 'en', format: 'en' };
let catalogue: Catalogue = english;
let revision = 0;
export async function useLocale(locale: Locale): Promise<boolean> {
  const request = ++revision;
  if (current.language === locale.language && current.format === locale.format) return false;
  const loaded = await loaders[locale.language]();
  if (request !== revision) return false;
  current = locale; catalogue = loaded; return true;
}
export function activeLocale(): Locale { return current; }
export function number(value: number, options?: Intl.NumberFormatOptions): string { return new Intl.NumberFormat(current.format, options).format(value); }
export function message(key: string, values?: Message['values']): Message { return { key, ...(values ? { values } : {}) }; }
function render(key: string, values: Message['values'], source: Catalogue, format: string): string {
  const entry = source[key as Key] ?? english[key as Key] ?? key;
  const template = typeof entry === 'string' ? entry : entry[new Intl.PluralRules(format).select(Number(values?.count ?? 0))] ?? entry.other ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => { const value = values?.[name]; return typeof value === 'number' ? new Intl.NumberFormat(format).format(value) : typeof value === 'object' && value ? render(value.key, value.values, source, format) : value ?? `{${name}}`; });
}
export function t(key: string, values?: Message['values']): string { return render(key, values, catalogue, current.format); }
export function term(namespace: string, value: string): string { const key = `${namespace}.${value}`; return Object.hasOwn(english, key) ? t(key) : value; }
export class UiError extends Error {
  readonly notice: Message;
  constructor(key: string, values?: Message['values']) { super(render(key, values, english, 'en')); this.notice = message(key, values); }
}
const phrases = new Map(Object.entries(english).filter((entry): entry is [Key, string] => typeof entry[1] === 'string').map(([key, value]) => [value, key]));
/** Fixed application errors can stay English in diagnostics; only presentation translates them. */
export function errorNotice(value: unknown): Message {
  if (value && typeof value === 'object' && 'notice' in value && value.notice && typeof value.notice === 'object' && 'key' in value.notice) { const note = value.notice as Message; return note; }
  if (value && typeof value === 'object' && 'code' in value) {
    const keys: Record<string, Key> = { MODEL_IO: 'error.prepare_this_model_in_managed_models_before_running_it', CANCELLED: 'status.cancelled' };
    const key = keys[String(value.code)]; if (key) return message(key);
  }
  const text = value && typeof value === 'object' && 'message' in value ? String(value.message) : String(value);
  const key = phrases.get(text); return message(key ?? 'ui.the_operation_could_not_finish');
}

export function errorText(value: unknown): string { const notice = errorNotice(value); return t(notice.key, notice.values); }
