import english from './locales/en.json' with { type: 'json' };
export const languages = [ ['de', 'Deutsch'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['it', 'Italiano'], ['pt-BR', 'Português'], ['ru', 'Русский'], ['zh-Hans', '中文'], ['ja', '日本語'], ['ko', '한국어'] ] as const;
export type Language = typeof languages[number][0];
export type Key = keyof typeof english;
export type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalogue = Record<Key, Entry>;
export interface Message { key: string; values?: Record<string, string | number | Message> }
export interface Locale { language: Language; format: string }
// Bundlers turn each catalogue into a module of its own, loaded only when chosen; an import
// attribute here would make the development server reject the module it serves.
const loaders = {
  en: async () => english,
  de: async () => (await import('./locales/de.json')).default,
  es: async () => (await import('./locales/es.json')).default,
  fr: async () => (await import('./locales/fr.json')).default,
  it: async () => (await import('./locales/it.json')).default,
  'pt-BR': async () => (await import('./locales/pt-BR.json')).default,
  ru: async () => (await import('./locales/ru.json')).default,
  'zh-Hans': async () => (await import('./locales/zh-Hans.json')).default,
  ja: async () => (await import('./locales/ja.json')).default,
  ko: async () => (await import('./locales/ko.json')).default,
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
/** Explicit app notices and structured runtime causes are the only presentation inputs. */
export function errorNotice(value: unknown, fallback: Key = 'error.unknown'): Message {
  if (value && typeof value === 'object' && 'notice' in value && value.notice && typeof value.notice === 'object' && 'key' in value.notice) return value.notice as Message;
  if (value && typeof value === 'object') {
    const error = value as { code?: string; kind?: string };
    const keys: Record<string, Key> = {
      MODEL_IO: 'error.prepare_this_model_in_managed_models_before_running_it',
      ENGINE_IO: 'error.engine', ENGINE_MISSING: 'error.engine', ENGINE_UNAVAILABLE: 'error.engine', ENGINE_INCOMPATIBLE: 'error.engine',
      DEPENDENCY_MISSING: 'error.engine', DEPENDENCY_INCOMPATIBLE: 'error.engine', BACKEND_UNAVAILABLE: 'error.engine', WORKER_UNAVAILABLE: 'error.engine',
      OUT_OF_MEMORY: 'error.memory', TIMEOUT: 'error.timeout',
      TERMINATION_FAILED: 'error.worker_termination_is_unconfirmed_restart_picpatch_before_starting_more_work',
      INTERRUPTED: 'error.interrupted', CANCELLED: 'status.cancelled',
      OUTPUT_CONFLICT: 'error.conflict', DESTINATION_CHANGED: 'error.conflict',
      FILE_NOT_FOUND: 'error.storage', PERMISSION_DENIED: 'error.storage', DISK_FULL: 'error.storage', IO_ERROR: 'error.storage', IMAGE_IO: 'error.storage', OUTPUT_IO: 'error.storage',
      CLEANUP_FAILED: 'error.cleanup',
      INVALID_REQUEST: 'error.input', INVALID_IMAGE: 'error.input', INVALID_MASK: 'error.input', INPUTS_CHANGED: 'error.input', UNSUPPORTED_CAPABILITY: 'error.input',
    };
    const key = error.code && Object.hasOwn(keys, error.code) && keys[error.code];
    if (key) return message(key);
    if (error.kind === 'invalid') return message('error.input');
    if (error.kind === 'cancelled') return message('status.cancelled');
  }
  return message(fallback);
}
export function errorText(value: unknown, fallback?: Key): string { const notice = errorNotice(value, fallback); return t(notice.key, notice.values); }
