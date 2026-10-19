// Display names and short descriptions for catalog models. The catalog is set once per
// overview, so any component can name a model from its id alone.
import { modelName } from '../../shared/model-name.ts';
import { t, term } from '../../shared/i18n/index.ts';
import type { CatalogModel } from './api.ts';

let names = new Map<string, string>();
export function setCatalog(models: readonly CatalogModel[]): void { names = new Map(models.map(model => [model.id, model.profile.name])); }
export function modelLabel(id: string): string { return names.get(id) ?? modelName(id); }

/** A name that tells a download apart from a registration of the user's own files. */
export function modelOption(model: CatalogModel): string { return `${model.profile.name} (${t(model.acquisition === 'pinned' ? 'model.download' : 'model.ownFiles')})`; }

/** What the model is good for, then how heavy and how well proven it is, as two short lines. */
export function modelSummary(model: CatalogModel): { purposes: string; facts: string } {
  const { profile } = model;
  const facts = [term('memory', profile.memory), term('speed', profile.speed), profile.licence === 'commercial' ? undefined : term('licence', profile.licence), term('evidence', model.evidence === 'real-weights' ? 'tested' : 'untested')];
  return { purposes: profile.purposes.slice(0, 3).map(purpose => term('purpose', purpose)).join(' · '), facts: facts.filter(Boolean).join(' · ') };
}
