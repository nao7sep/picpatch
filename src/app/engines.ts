import type { EngineRuntime, ModelCatalogEntry } from 'picpatchsdk';

/** Python setup follows the selected model; native models use their separate installer. */
export function pythonRuntime(models: readonly ModelCatalogEntry[], modelId?: string): EngineRuntime {
  const runtime = models.find(model => model.id === modelId)?.runtime.name;
  return runtime === 'dreamo' || runtime === 'diffusers' ? runtime : 'mflux';
}
