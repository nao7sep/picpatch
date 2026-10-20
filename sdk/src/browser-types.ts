// The browser entry (picpatchsdk/types): the public types, code tables and pure checks a window
// needs before it calls the SDK, so no window restates an SDK rule. Nothing here may depend on
// Node; tsconfig.types.json checks it against browser libraries alone.
export type { ArtifactRecord, SamplingParameters, ReferenceGroup, ModelCapabilities, LocalModel, ModelManifest, OutpaintCanvas, StructuralControl, RecordOptions, SidecarOutcome } from './contracts.generated.ts';
export type { Evidence, LicenceKind, MemoryClass, ModelProfile, Operation, Purpose, SpeedClass, Tier } from './models/profiles.ts';
export type { HostId, RuntimeName } from './hosts.ts';
export type { CallOptions, ErrorCode, ErrorEffect, ErrorKind, ImageSize, PicPatchProfile, PicPatchSdkErrorData, ProgressEvent, Refusal, RefusalCode, RefusalDetails, SdkEvent, ModelPresenceIssue, SavedArtifact, SaveArtifactRefusal } from './types.ts';
export { refusalCodes } from './types.ts';
export type { CatalogModel, CatalogRuntime, ExternalModel, ManagedModelEntry, ManagedModelInventory, ModelCatalogEntry, ModelInventoryFailure, ModelOpenResult, ModelRegistration, OpenedModel } from './models/types.ts';
export type { EngineInspection, NativeEngineInspection, PythonRuntime } from './runtime/engine/types.ts';
export { admissionCodes, admissionIssues } from './admission.ts';
export type { AdmissionCode, AdmissionIssue, AdmissionRequest } from './admission.ts';
