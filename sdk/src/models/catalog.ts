import { nativeModels } from '../backends/stable-diffusion-cpp/models.ts';
import manifest from './catalog/klein-4b-4bit.manifest.json' with { type: 'json' };
import distilled9Manifest from './catalog/klein-9b-4bit.manifest.json' with { type: 'json' };
import base9Manifest from './catalog/klein-base-9b-4bit.manifest.json' with { type: 'json' };
import zImageManifest from './catalog/z-image-turbo-4bit.manifest.json' with { type: 'json' };
import fillManifest from './catalog/flux1-fill-dev-4bit.manifest.json' with { type: 'json' };
import { externalModels, modelCapabilities, modelDefinition } from './variants.ts';
import { PicPatchSdkError } from '../errors.ts';
import { modelEvidence, modelProfile } from './profiles.ts';
import { validateModelManifest } from './verification.ts';
import { checkFileHeader, fileContent } from '../file-header.ts';
import { runtimeHosts, supportsRuntime } from '../hosts.ts';
import { runtimeVersions } from '../runtime/engine/versions.ts';

export type { CatalogModel, CatalogRuntime, ExternalModel, ModelCatalogEntry } from './types.ts';
import type { CatalogModel, ModelCatalogEntry } from './types.ts';
function buildCatalog(): ModelCatalogEntry[] {
  const configurations = [
    { manifest, variant: 'flux2-klein-4b' as const, license: 'Apache-2.0', licenseUrl: `https://huggingface.co/${manifest.source.repository}/blob/${manifest.source.revision}/README.md` },
    { manifest: base9Manifest, variant: 'flux2-klein-base-9b' as const, license: 'flux-non-commercial-license', licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9B/blob/main/LICENSE.md' },
    { manifest: distilled9Manifest, variant: 'flux2-klein-9b' as const, license: 'flux-non-commercial-license', licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md' },
    { manifest: zImageManifest, variant: 'z-image-turbo' as const, license: 'Apache-2.0', licenseUrl: `https://huggingface.co/${zImageManifest.source.repository}/blob/${zImageManifest.source.revision}/README.md` },
    { manifest: fillManifest, variant: 'flux1-fill-dev' as const, license: 'flux-1-dev-non-commercial-license', licenseUrl: `https://huggingface.co/${fillManifest.source.repository}/blob/${fillManifest.source.revision}/README.md` },
  ];
  const pinned = configurations.map((configuration): CatalogModel => {
    if (checkFileHeader(configuration.manifest, 'model-manifest').status !== 'current') throw new PicPatchSdkError('INTERNAL', 'A bundled model manifest has the wrong header.');
    const pinned = validateModelManifest(fileContent(configuration.manifest));
    return { id: pinned.model, capabilities: modelCapabilities(configuration.variant, pinned.model), acquisition: 'pinned', family: modelDefinition(configuration.variant).family, ...modelEvidence(pinned.model, 'api'), profile: modelProfile(configuration.variant), variant: configuration.variant, manifest: pinned,
      downloadBytes: pinned.components.reduce((total, component) => total + component.bytes, 0),
      sourceUrl: `https://huggingface.co/${pinned.source.repository}/tree/${pinned.source.revision}`,
      license: { id: configuration.license, url: configuration.licenseUrl },
      runtime: { name: 'mflux', engine: 'python', version: runtimeVersions.mflux, hosts: runtimeHosts('mflux') }, supported: supportsRuntime('mflux') };
  });
  return [...pinned, ...externalModels(), ...nativeModels()];
}
// Built once; callers only ever receive copies, so the private entries and the shared definitions they reference stay unchanged.
let catalog: { entries: ModelCatalogEntry[]; byId: Map<string, ModelCatalogEntry> } | undefined;
function modelCatalog() {
  if (!catalog) {
    const entries = buildCatalog();
    catalog = { entries, byId: new Map(entries.map(entry => [entry.id, entry])) };
  }
  return catalog;
}
/** Pinned community quantization, not an official upstream weight distribution. Caller-owned entries. */
export function listModels(): ModelCatalogEntry[] {
  return structuredClone(modelCatalog().entries);
}
export function catalogModel(id: string): ModelCatalogEntry {
  const entry = modelCatalog().byId.get(id);
  if (!entry) throw new PicPatchSdkError('INVALID_REQUEST', 'Choose a model ID returned by listModels.');
  return structuredClone(entry);
}
