export { VERSION } from './version.ts';
export { createImageClient } from './client.ts';
export type { ImageClient, ImageClientOptions } from './client.ts';
export type { ImageResult, ImageOutcome, OperationRefusal, GenerateRequest, GenerateResult, EditRequest, EditResult, InputGeometry, ImageArtifact, ImageSize, ModelCapabilities, OperationOptions, ProgressEvent, ReferenceGroup } from './types.ts';
export { validateEditRequest, validateGenerateRequest } from './validation.ts';
export { PicPatchSdkError, isPicPatchSdkError, errorCodes } from './errors.ts';
export type { PicPatchSdkErrorData, SdkErrorOptions, ErrorCode, ErrorKind, ErrorEffect, ErrorDetails } from './errors.ts';

export { inspectModel, discoverModels } from './models/inspection.ts';
export type { ModelInspection, LocalModelFile, ModelIssue, ModelDiscovery, ModelDiscoveryFailure, ModelOperationOptions } from './models/types.ts';
export { validateModelManifest, verifyModel } from './models/verification.ts';
export type { ModelManifest, ModelComponent, ModelVerification, ModelVerificationOptions, VerifiedComponent } from './models/types.ts';
export { inspectRuntime } from './runtime/inspection.ts';
export type { RuntimeInspection, RuntimeOperationOptions } from './runtime/types.ts';

export type { LocalModel } from './contracts.generated.ts';
export { resolveStoragePaths } from './paths.ts';
export type { StorageOptions, StoragePaths } from './paths.ts';
export { listModels } from './models/catalog.ts';
export type { ModelVariant, ExternalModel } from './models/variants.ts';
export type { CatalogModel, ModelCatalogEntry } from './models/catalog.ts';
export type { Evidence, LicenceKind, MemoryClass, ModelProfile, Operation, Purpose, SpeedClass, Tier } from './models/profiles.ts';
export { prepareModel } from './models/preparation.ts';
export type { PrepareModelOptions, PreparedModel } from './models/preparation.ts';
export { inspectReadiness } from './runtime/readiness.ts';
export type { ReadinessOptions, ModelReadiness } from './runtime/readiness.ts';
export type { RuntimeCheck } from './worker/protocol.ts';

export type { GenerateInput, EditInput, ImageDefaults } from './defaults.ts';
export type { SdkEvent, EventOptions, WorkerDiagnostic, RuntimeConfiguration } from './diagnostics.ts';

export type { SamplingParameters, ParameterCapabilities } from './contracts.generated.ts';

export type { ArtifactRecord, SidecarOptions, SidecarOutcome, ConditioningProvenance } from './contracts.generated.ts';

export type { OutpaintCanvas, OutpaintGeometry } from './contracts.generated.ts';

export type { LocalLora, LoraProvenance } from './contracts.generated.ts';
export type { LocalControlNet, StructuralControl, ControlProvenance } from './contracts.generated.ts';

export { installEngine, inspectEngine } from './runtime/engine/engine.ts';
export type { EngineRuntime, EngineOptions, InstallEngineOptions, EngineIdentity, EngineRecord, ReadyEngine, EngineInspection, EngineInstallation } from './runtime/engine/types.ts';

export { readProfile, validateProfile } from './profile.ts';
export type { PicPatchProfile, ProfileReadOptions, ProfileReadResult, ProfileRefusal } from './profile.ts';
export type { WorkerTimeouts } from './worker/process.ts';

export type { ImagePlan, GenerateImagePlan, EditImagePlan, PlannedImageInput } from './images/planning.ts';
export type { ImageFingerprint } from './images/fingerprint.ts';
export type { PlannedDestination } from './images/output.ts';

export { openModel, inspectModels, readModelRegistration, validateModelRegistration } from './models/opening.ts';
export type { ModelRegistration, ModelOpenOptions, ModelPresenceIssue, OpenedModel, ModelOpenRefusal, ModelOpenResult, ManagedModelInventory, ModelInventoryFailure } from './models/opening.ts';

export { readArtifactRecord, verifyArtifact, validateArtifactRecord } from './images/records.ts';
export type { ArtifactReadOptions, ArtifactRefusal, ArtifactVerification } from './images/records.ts';


export { saveArtifact } from './images/saving.ts';
export type { SaveArtifactOptions, SavedArtifact, SaveArtifactRefusal } from './images/saving.ts';

export { removeModel } from './models/managed.ts';
export type { ManagedModelEntry, RemoveModelResult } from './models/managed.ts';

export { inspectNativeEngine, installNativeEngine } from './runtime/engine/native.ts';
export type { ReadyNativeEngine, NativeEngineInspection, NativeEngineInstallation } from './runtime/engine/native.ts';
export { hostId, runtimeHosts, supportsRuntime } from './platform.ts';
export type { Host, HostId, RuntimeName } from './platform.ts';
