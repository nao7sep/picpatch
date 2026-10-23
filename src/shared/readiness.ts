import type { Message } from './i18n/index.ts';
/** Whether a model can run now, by catalog id: ready, missing files or engine, or a failed check. */
export type ModelState = 'ready' | 'missing' | 'engineMissing' | { status: 'failed'; notice: Message };
export type Readiness = Record<string, ModelState>;
