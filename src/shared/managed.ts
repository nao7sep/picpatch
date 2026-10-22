import type { Message } from './i18n/index.ts';

/** The model and engine operations Managed tools and Setup start; one runs at a time. */
export type ManagedAction = 'installPython' | 'installNative' | 'download' | 'register' | 'verify' | 'remove';
export interface ManagedTarget { action: ManagedAction; modelId?: string; revision?: string }
/** A running operation, as application state holds it whether or not a view shows it. */
export interface ManagedOperation extends ManagedTarget { id: number; progress?: { completed: number; total: number } }
/** The terminal result of the latest operation: exactly one per operation, correlated by id. */
export interface ManagedResult extends ManagedTarget { id: number; status: 'completed' | 'refused' | 'failed' | 'cancelled'; notice?: Message }
export interface ManagedState { active?: ManagedOperation; last?: ManagedResult }

/** Whether a running or finished operation is the one a row or step stands for. */
export const sameTarget = (a: ManagedTarget | undefined, b: ManagedTarget) =>
  Boolean(a) && a!.action === b.action && a!.modelId === b.modelId && a!.revision === b.revision;
