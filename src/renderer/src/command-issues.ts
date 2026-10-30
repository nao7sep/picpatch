// Why the composer cannot run its command yet. The SDK stays authoritative at
// execution; this only explains early, and never changes the draft.
import { incompatibilities } from '../../shared/admission.ts';
import { commandTargetReady } from '../../shared/image-command.ts';
import type { Draft, Session } from '../../shared/session.ts';
import type { CatalogModel, Readiness } from './api.ts';
import { fieldProblem, type FieldEdit } from './number-field.tsx';

export type CommandIssue =
  | { kind: 'checking' }
  | { kind: 'unready'; models: string[] }
  | { kind: 'waiting' }
  | { kind: 'noModel' }
  | { kind: 'model'; model: string; reason: string }
  | { kind: 'field'; text: string };

/** Whether a number field is still part of the command; a field that went away with its option no longer holds Send back. */
export function fieldApplies(id: string, draft: Draft, models: readonly CatalogModel[]): boolean {
  if (id.startsWith('outpaint.')) return Boolean(draft.source && draft.outpaint);
  if (id === 'control.strength') return Boolean(draft.control);
  if (id.startsWith('parameter.')) {
    const key = id.slice('parameter.'.length);
    const parameters = models.find(model => model.id === draft.modelIds[0])?.capabilities.parameters as Record<string, unknown> | undefined;
    return Boolean(parameters?.[key]) || (draft.parameters as Record<string, unknown>)[key] !== undefined;
  }
  return true;
}

export function commandIssues(session: Session, draft: Draft, models: readonly CatalogModel[], readiness: Readiness | undefined, edits: Readonly<Record<string, FieldEdit>> = {}): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const field = fieldProblem(edits, id => fieldApplies(id, draft, models));
  if (field) issues.push({ kind: 'field', text: field });
  if (!draft.modelIds.length) issues.push({ kind: 'noModel' });
  if (!readiness) issues.push({ kind: 'checking' });
  else {
    // A model this computer cannot run (for example a session from a Mac) is reported below as unavailable, not as one to set up.
    const unready = draft.modelIds.filter(id => readiness[id] !== 'ready' && models.some(model => model.id === id));
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
