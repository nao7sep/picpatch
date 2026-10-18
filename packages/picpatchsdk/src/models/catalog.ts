import { nativeModels } from '../backends/stable-diffusion-cpp/models.ts';
import manifest from './catalog/klein-4b-4bit.manifest.json' with { type: 'json' };
import distilled9Manifest from './catalog/klein-9b-4bit.manifest.json' with { type: 'json' };
import base9Manifest from './catalog/klein-base-9b-4bit.manifest.json' with { type: 'json' };
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
  const configurations = [
    { manifest, variant: 'flux2-klein-4b' as const, license: 'Apache-2.0', licenseUrl: `https://huggingface.co/${manifest.source.repository}/blob/${manifest.source.revision}/README.md` },
    { manifest: base9Manifest, variant: 'flux2-klein-base-9b' as const, license: 'flux-non-commercial-license', licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9B/blob/main/LICENSE.md' },
    { manifest: distilled9Manifest, variant: 'flux2-klein-9b' as const, license: 'flux-non-commercial-license', licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md' },
  ];
  const pinned = configurations.map((configuration): CatalogModel => {
    const pinned = validateModelManifest(configuration.manifest);
    return { id: pinned.model, capabilities: modelCapabilities(configuration.variant, pinned.model), acquisition: 'pinned', family: 'flux2-klein', evidence: 'inference-tested', variant: configuration.variant, status: 'experimental', manifest: pinned,
      downloadBytes: pinned.components.reduce((total, component) => total + component.bytes, 0),
      sourceUrl: `https://huggingface.co/${pinned.source.repository}/tree/${pinned.source.revision}`,
      license: { id: configuration.license, url: configuration.licenseUrl },
      runtime: { name: 'mflux', version: '0.22.0', platform: 'darwin', architecture: 'arm64' } };
  });
  return [...pinned, ...externalModels(), ...nativeModels()];
}
export type ModelSelection = CatalogModel | ExternalModel | ReturnType<typeof nativeModels>[number];
export function catalogModel(id: string): ModelSelection {
  const entry = listModels().find(model => model.id === id);
  if (!entry) throw new PicPatchUsageError('INVALID_REQUEST', 'Choose a model ID returned by listModels.');
  return entry;
}
