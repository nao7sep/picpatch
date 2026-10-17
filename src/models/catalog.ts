import { nativeModels } from '../backends/stable-diffusion-cpp/models.ts';
import manifest from './catalog/klein-4b-4bit.manifest.json' with { type: 'json' };
import type { LocalEditingModel, ModelManifest, ModelCapabilities } from '../contracts.generated.ts';
import { externalModels, modelCapabilities, type ExternalModel } from './variants.ts';
import { PicPatchUsageError } from '../errors.ts';
import { validateModelManifest } from './verification.ts';

export interface CatalogModel {
  id: string;
  capabilities: ModelCapabilities;
  acquisition: 'pinned';
  family: string;
  evidence: 'inference-tested';
  variant: LocalEditingModel['variant'];
  status: 'experimental';
  manifest: ModelManifest;
  downloadBytes: number;
  sourceUrl: string;
  license: { id: string; url: string };
  runtime: { name: 'mflux'; version: string; platform: 'darwin'; architecture: 'arm64' };
}
/** Pinned community quantization, not an official upstream weight distribution. */
export function listModels(): ModelSelection[] {
  const pinned = validateModelManifest(manifest);
  const sourceUrl = `https://huggingface.co/${pinned.source.repository}/tree/${pinned.source.revision}`;
  return [{ id: pinned.model, capabilities: modelCapabilities('flux2-klein-4b', pinned.model), acquisition: 'pinned', family: 'flux2-klein', evidence: 'inference-tested', variant: 'flux2-klein-4b', status: 'experimental', manifest: pinned,
    downloadBytes: pinned.components.reduce((total, component) => total + component.bytes, 0), sourceUrl,
    license: { id: 'Apache-2.0', url: `https://huggingface.co/${pinned.source.repository}/blob/${pinned.source.revision}/README.md` },
    runtime: { name: 'mflux', version: '0.22.0', platform: 'darwin', architecture: 'arm64' } }, ...externalModels(), ...nativeModels()];
}
export type ModelSelection = CatalogModel | ExternalModel | ReturnType<typeof nativeModels>[number];
export function catalogModel(id: string): ModelSelection {
  const entry = listModels().find(model => model.id === id);
  if (!entry) throw new PicPatchUsageError('INVALID_REQUEST', 'Choose a model ID returned by listModels.');
  return entry;
}
