// Display names and short descriptions for catalog models. The catalog is set once per
// overview, so any component can name a model from its id alone.
import { modelName } from '../../shared/model-name.ts';
import { t, term } from '../../shared/i18n/index.ts';
import type { CatalogModel } from './api.ts';

let catalog = new Map<string, CatalogModel>();
export function setCatalog(models: readonly CatalogModel[]): void { catalog = new Map(models.map(model => [model.id, model])); }
export function modelLabel(id: string): string { return catalog.get(id)?.profile.name ?? modelName(id); }

export function modelCapabilities(id: string) { return catalog.get(id)?.capabilities; }

/** Recommended models first, then standard, then specialist. */
export const tierOrder = { recommended: 0, standard: 1, specialist: 2 } as const;

/** A name that tells a download apart from a registration of the user's own files. */
export function modelOption(model: CatalogModel): string { return `${model.profile.name} (${t(model.acquisition === 'pinned' ? 'model.download' : 'model.ownFiles')})`; }

/** What the model is good for, then how heavy and how well proven it is, as two short lines. */
export function modelSummary(model: CatalogModel): { purposes: string; facts: string } {
  const { profile } = model;
  const facts = [term('memory', profile.memory), term('speed', profile.speed), profile.licence === 'commercial' ? undefined : term('licence', profile.licence), term('evidence', model.evidence === 'real-weights' ? 'tested' : 'untested')];
  return { purposes: profile.purposes.slice(0, 3).map(purpose => term('purpose', purpose)).join(' · '), facts: facts.filter(Boolean).join(' · ') };
}

/**
 * One row per model, whether it comes as a download, from the user's own files, or both: the row uses the copy that is
 * selected or ready, preferring the user's own files when both are ready, since registering them was a deliberate choice.
 */
export function modelRows(models: readonly CatalogModel[], selected: readonly string[], state: (id: string) => string): { model: CatalogModel; copies: CatalogModel[] }[] {
  const byVariant = new Map<string, CatalogModel[]>();
  for (const model of models) byVariant.set(model.variant, [...(byVariant.get(model.variant) ?? []), model]);
  return [...byVariant.values()].map(copies => {
    const chosen = copies.find(copy => selected.includes(copy.id))
      ?? copies.find(copy => copy.acquisition !== 'pinned' && state(copy.id) === 'ready')
      ?? copies.find(copy => state(copy.id) === 'ready')
      ?? copies.find(copy => copy.acquisition === 'pinned') ?? copies[0]!;
    return { model: chosen, copies };
  });
}
