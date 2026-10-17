export { createEditor } from './client.ts';
export type { Editor, EditorOptions } from './client.ts';
export type { GenerateRequest, GenerateResult, EditRequest, EditResult, InputGeometry, ImageArtifact, ImageSize, ModelCapabilities, OperationOptions, ProgressEvent, ReferenceGroup } from './types.ts';
export { validateEditRequest, validateGenerateRequest } from './validation.ts';
export { PicPatchUsageError, PicPatchRuntimeError, PicPatchCancelledError } from './errors.ts';

export { inspectModel, discoverModels } from './models/inspection.ts';
export type { ModelInspection, LocalModelFile, ModelIssue, ModelDiscovery, ModelOperationOptions, ModelProgressEvent } from './models/types.ts';
export { validateModelManifest, verifyModel } from './models/verification.ts';
export type { ModelManifest, ModelComponent, ModelVerification, ModelVerificationOptions, VerifiedComponent } from './models/types.ts';
export { inspectRuntime } from './runtime/inspection.ts';
export type { RuntimeInspection, RuntimeOperationOptions, RuntimeProgressEvent } from './runtime/types.ts';

export type { LocalEditingModel } from './contracts.generated.ts';
export { resolveStoragePaths } from './paths.ts';
export type { StorageOptions, StoragePaths } from './paths.ts';
export { listModels } from './models/catalog.ts';
export type { ModelVariant } from './models/variants.ts';
export type { CatalogModel, ModelSelection } from './models/catalog.ts';
export { prepareModel } from './models/preparation.ts';
export type { PrepareModelOptions, PreparedModel } from './models/preparation.ts';
export { inspectReadiness } from './runtime/readiness.ts';
export type { ReadinessOptions, ModelReadiness } from './runtime/readiness.ts';

export type { GenerateInput, EditInput, EditDefaults } from './defaults.ts';
export type { DiagnosticEvent, DiagnosticOptions, WorkerDiagnostic } from './diagnostics.ts';

export type { SamplingParameters, ParameterCapabilities } from './contracts.generated.ts';

export type { ArtifactRecord, SidecarOptions, SidecarOutcome, ConditioningProvenance } from './contracts.generated.ts';

export type { OutpaintCanvas, OutpaintGeometry } from './contracts.generated.ts';
