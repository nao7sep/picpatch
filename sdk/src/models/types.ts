import type { CallOptions, ModelPresenceIssue, PicPatchSdkErrorData, Refusal } from '../types.ts';
import type { LocalModel, ModelCapabilities, ModelManifest } from '../contracts.generated.ts';
import type { HostId, RuntimeName } from '../hosts.ts';
import type { Evidence, ModelProfile, Operation } from './profiles.ts';
/** Local presence is not integrity verification or runtime compatibility. */
export interface LocalModelFile {
  path: string;
  resolvedPath: string;
  kind: 'weights' | 'configuration' | 'partial';
  bytes: number;
}
export interface ModelInspection {
  path: string;
  resolvedPath: string;
  status: 'unverified' | 'incomplete' | 'unrecognized';
  files: LocalModelFile[];
  issues: ModelIssue[];
  integrity: 'not-verified';
  compatibility: 'unknown';
}
export interface ModelIssue {
  path: string;
  code: 'MISSING_FILE' | 'EMPTY_FILE' | 'PARTIAL_FILE' | 'SKIPPED_DIRECTORY_LINK';
  message: string;
  effect: 'none';
}

/** Inspection, discovery and verification read local files alone, with no deadline. */
export type ModelOperationOptions = CallOptions;
export interface ModelDiscovery {
  models: ModelInspection[];
  failures?: ModelDiscoveryFailure[];
}
export interface ModelDiscoveryFailure { path: string; error: PicPatchSdkErrorData }

export type { ModelManifest, ModelComponent } from '../contracts.generated.ts';
export interface ModelVerification {
  path: string;
  manifest: import('../contracts.generated.ts').ModelManifest;
  status: 'matches-manifest' | 'invalid';
  compatibility: 'unknown';
  components: VerifiedComponent[];
}
export interface VerifiedComponent {
  code: 'MODEL_COMPONENT_VERIFIED' | 'MODEL_COMPONENT_MISSING' | 'MODEL_COMPONENT_NOT_FILE' | 'MODEL_COMPONENT_PATH_ESCAPE' | 'MODEL_COMPONENT_SIZE_MISMATCH' | 'MODEL_COMPONENT_DIGEST_MISMATCH' | 'MODEL_COMPONENT_CHANGED' | 'MODEL_COMPONENT_INVALID_INDEX';
  message: string;
  effect: 'none';
  path: string;
  status: 'verified' | 'missing' | 'not-file' | 'path-escape' | 'size-mismatch' | 'digest-mismatch' | 'changed' | 'invalid-index';
  sha256?: string;
}

export type ModelVerificationOptions = ModelOperationOptions;

interface CatalogBase {
  id: string;
  variant: LocalModel['variant'];
  family: string;
  capabilities: ModelCapabilities;
  evidence: Evidence;
  /** Operations that ran with real trained weights for this exact selection. */
  tested: Operation[];
  profile: ModelProfile;
  /** Whether this computer is one of the runtime's hosts. */
  supported: boolean;
}
/**
 * The runtime a selection runs on, the hosts it has a build for, and which engine verbs prepare it:
 * python is inspectEngine and installEngine with runtime: name, native is inspectNativeEngine and installNativeEngine.
 */
export type CatalogRuntime<N extends RuntimeName = RuntimeName> = { name: N; engine: N extends 'stable-diffusion.cpp' ? 'native' : 'python'; version: string; hosts: readonly HostId[] };
/** A pinned download: community quantization, not an official upstream weight distribution. */
export interface CatalogModel extends CatalogBase {
  acquisition: 'pinned';
  manifest: ModelManifest;
  downloadBytes: number;
  sourceUrl: string;
  license: { id: string; url: string };
  runtime: CatalogRuntime<'mflux'>;
}
/** A selection prepared from the caller's own files. */
export interface ExternalModel extends CatalogBase {
  acquisition: 'external';
  runtime: CatalogRuntime<'mflux'> | CatalogRuntime<'dreamo'> | CatalogRuntime<'diffusers'> | CatalogRuntime<'stable-diffusion.cpp'>;
}
export type ModelCatalogEntry = CatalogModel | ExternalModel;

/** Persist this envelope, not an inference session or historical verification claim. */
export interface ModelRegistration { version: 1; model: LocalModel }
export type ModelRegistrationResult = { status: 'completed'; registration: ModelRegistration } | Refusal<'MODEL_REGISTRATION_VERSION_UNSUPPORTED'>;
export interface OpenedModel extends ModelRegistration {
  status: 'completed';
  integrity: 'presence-only';
  compatibility: 'unknown';
}
/** details.issues lists the components that are not present at their declared location and size. */
export type ModelOpenRefusal = Refusal<'MODEL_INCOMPLETE' | 'MODEL_REGISTRATION_VERSION_UNSUPPORTED'>;
export type ModelOpenResult = OpenedModel | ModelOpenRefusal;
export type { ModelPresenceIssue };
export interface ManagedModelEntry {
  modelId: string;
  name: string;
  directory: string;
  kind: 'revision' | 'incomplete';
  current: boolean;
  /** Regular-file bytes in this directory; symlink targets are never counted or traversed. */
  bytes: number;
}
export interface ModelInventoryFailure { status: 'failed'; error: PicPatchSdkErrorData }
export interface ManagedModelInventory { entries: ManagedModelEntry[]; models: { id: string; directory: string; status: 'present' | 'missing' | 'incomplete' | 'failed'; result: ModelOpenResult | ModelInventoryFailure }[] }
