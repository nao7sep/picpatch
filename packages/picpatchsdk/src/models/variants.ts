import { contractValidator } from '../contracts.ts';
import definitions from '../../runtimes/mflux/src/picpatch_worker/backends/models.json' with { type: 'json' };
import type { LocalEditingModel, ModelCapabilities } from '../contracts.generated.ts';
import { PicPatchSdkError } from '../errors.ts';

export type ModelVariant = LocalEditingModel['variant'];
export function modelDefinition(id: string) {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new PicPatchSdkError('INVALID_REQUEST', 'Unknown model variant. Choose a model returned by listModels.');
  return structuredClone(definition);
}
export function modelCapabilities(variant: string, model: string = variant): ModelCapabilities {
  const capabilities = { ...modelDefinition(variant).capabilities, model };
  if (!contractValidator<ModelCapabilities>('ModelCapabilities')(capabilities)) throw new Error('Invalid bundled model capabilities.');
  return capabilities;
}
export function externalModels() {
  return definitions.map(item => ({ id: item.id, variant: item.id as ModelVariant,
    family: item.family, capabilities: modelCapabilities(item.id), acquisition: 'external' as const, status: 'experimental' as const,
    evidence: 'api-tested' as const,
    runtime: { name: 'mflux' as const, version: '0.22.0', platform: 'darwin' as const, architecture: 'arm64' as const } }));
}
export type ExternalModel = ReturnType<typeof externalModels>[number];
