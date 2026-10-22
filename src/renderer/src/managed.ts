// How a model or engine operation reads wherever it is shown: Managed tools, Setup and the standing notice.
import type { ManagedOperation, ManagedResult } from '../../shared/managed.ts';
import { message, type Message } from '../../shared/i18n/index.ts';
import { modelLabel } from './models.ts';

const done = { installPython: 'management.installed', installNative: 'management.installed', download: 'management.downloaded', register: 'management.registered', verify: 'management.verified', remove: 'management.removed' } as const;

/** "Downloading FLUX.2 Klein 4B…", with its share done when the operation reports one. */
export function runningMessage(operation: ManagedOperation): Message {
  const task = message(`managed.running.${operation.action}`, { model: operation.modelId ? modelLabel(operation.modelId) : '' });
  const { progress } = operation;
  if (!progress || !progress.total) return task;
  return message('managed.progress', { task, percent: Math.min(100, Math.floor(progress.completed / progress.total * 100)) });
}

/** What a finished operation reports: success, a cancellation, or the reason it refused or failed. */
export function resultMessage(result: ManagedResult): Message {
  if (result.status === 'completed') return message(done[result.action]);
  if (result.status === 'cancelled') return message('managed.cancelled');
  return result.notice ?? message('error.unknown');
}
