import { contractValidator } from '../contracts.ts';
import mfluxDefinitions from '../../runtimes/mflux/src/picpatch_worker/backends/models.json' with { type: 'json' };
import dreamoDefinitions from '../../runtimes/dreamo/src/picpatch_dreamo/models.json' with { type: 'json' };
import diffusersDefinitions from '../../runtimes/diffusers/src/picpatch_diffusers/models.json' with { type: 'json' };
import type { EngineRuntime } from '../runtime/engine/types.ts';
const definitions = [...mfluxDefinitions, ...dreamoDefinitions, ...diffusersDefinitions];
export function modelRuntime(variant?: string): EngineRuntime {
  if (diffusersDefinitions.some(item => item.id === variant)) return 'diffusers';
  if (dreamoDefinitions.some(item => item.id === variant)) return 'dreamo';
  return 'mflux';
}
import type { LocalModel, ModelCapabilities } from '../contracts.generated.ts';
import { PicPatchSdkError } from '../errors.ts';
import { modelEvidence, modelProfile } from './profiles.ts';

export type ModelVariant = LocalModel['variant'];
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
    family: item.family, capabilities: modelCapabilities(item.id), acquisition: 'external' as const,
    ...modelEvidence(item.id, 'api'), profile: modelProfile(item.id),
    runtime: { name: modelRuntime(item.id), version: { mflux: '0.22.0', dreamo: '1.1', diffusers: '0.41.0' }[modelRuntime(item.id)], platform: 'darwin' as const, architecture: 'arm64' as const } }));
}
export type ExternalModel = ReturnType<typeof externalModels>[number];
