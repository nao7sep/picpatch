// Why the composer cannot run its command yet. The SDK stays authoritative at
// execution; this only explains early, and never changes the draft.
import { incompatibilities } from '../../shared/admission.ts';
import { commandTargetReady } from '../../shared/image-command.ts';
import type { Draft, Session } from '../../shared/session.ts';
import type { CatalogModel, Readiness } from './api.ts';

export type CommandIssue =
  | { kind: 'checking' }
  | { kind: 'unready'; models: string[] }
  | { kind: 'waiting' }
  | { kind: 'noModel' }
  | { kind: 'model'; model: string; reason: string };

export function commandIssues(session: Session, draft: Draft, models: readonly CatalogModel[], readiness: Readiness | undefined): CommandIssue[] {
  const issues: CommandIssue[] = [];
  if (!draft.modelIds.length) issues.push({ kind: 'noModel' });
  if (!readiness) issues.push({ kind: 'checking' });
  else {
    const unready = draft.modelIds.filter(id => readiness[id] !== 'ready');
    if (unready.length) issues.push({ kind: 'unready', models: unready });
  }
  if (!commandTargetReady(session, draft)) issues.push({ kind: 'waiting' });
  for (const id of draft.modelIds) {
    const model = models.find(item => item.id === id);
    if (!model) { issues.push({ kind: 'model', model: id, reason: '' }); continue; }
    for (const reason of incompatibilities(draft, model.capabilities)) issues.push({ kind: 'model', model: id, reason });
  }
  return issues;
}
