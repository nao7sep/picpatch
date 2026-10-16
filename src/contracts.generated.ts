/* Generated from protocol/contracts.schema.json. Run npm run contracts:generate. */

export interface EditRequestContract {
  model: string;
  instruction: string;
  sourceImage?: string;
  /**
   * @minItems 1
   */
  references?: [ReferenceGroup, ...ReferenceGroup[]];
  maskImage?: string;
  outputPath: string;
  seed?: number;
  size?: ImageSize;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ReferenceGroup".
 */
export interface ReferenceGroup {
  id: string;
  role: "subject" | "object" | "style" | "background";
  /**
   * @minItems 1
   */
  images: [string, ...string[]];
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ImageSize".
 */
export interface ImageSize {
  width: number;
  height: number;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "EditRequest".
 */
export interface EditRequest {
  model: string;
  instruction: string;
  sourceImage?: string;
  /**
   * @minItems 1
   */
  references?: [ReferenceGroup, ...ReferenceGroup[]];
  maskImage?: string;
  outputPath: string;
  seed?: number;
  size?: ImageSize;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ModelCapabilities".
 */
export interface ModelCapabilities {
  model: string;
  instructionEditing: boolean;
  referenceRoles: ("subject" | "object" | "style" | "background")[];
  /**
   * Limit on grouped reference images, excluding the source. Absence means no declared limit, not unlimited hardware capacity.
   */
  maxReferenceImages?: number;
  maskMode: "none" | "native" | "composite";
  size?: {
    widthMultiple: number;
    heightMultiple: number;
    maxWidth?: number;
    maxHeight?: number;
  };
  /**
   * Whether this adapter requires a source image in addition to any references. Absence means unspecified.
   */
  sourceImageRequired?: boolean;
  /**
   * Source first, then groups and images in caller order. Group IDs and roles are prompt labels, not separate model controls or identity guarantees.
   */
  referenceConditioning?: "ordered-images-with-role-prompt";
  defaultOutputSize?: ImageSize;
  /**
   * Aspect-preserving downscale to 1024 squared pixels, then center crop to multiples of 16. Applies to source and references.
   */
  inputGeometry?: "klein-reference";
  /**
   * Explicit text-only generation support. Absence means unsupported.
   */
  textToImage?: boolean;
  /**
   * Whether every edit requires a mask as well as its source image.
   */
  maskRequired?: boolean;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ImageArtifact".
 */
export interface ImageArtifact {
  path: string;
  mimeType: "image/png";
  size: ImageSize;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "EditResult".
 */
export interface EditResult {
  image: ImageArtifact;
  model: string;
  modelRevision: string;
  runtime: {
    name: string;
    version: string;
  };
  seed: number;
  references: ReferenceGroup[];
  cleanupWarning?: {
    directory: string;
    message: string;
  };
  inputGeometry?: InputGeometry[];
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "InputGeometry".
 */
export interface InputGeometry {
  path: string;
  originalSize: ImageSize;
  orientedSize: ImageSize;
  scaledSize: ImageSize;
  preparedSize: ImageSize;
  crop: {
    left: number;
    top: number;
  };
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ProgressEvent".
 */
export interface ProgressEvent {
  type: "progress";
  verb: "edit" | "generate";
  stage: "preparing" | "loading" | "editing" | "saving" | "generating";
  message: string;
  completed?: number;
  total?: number;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ModelComponent".
 */
export interface ModelComponent {
  path: string;
  role: "weights" | "configuration" | "tokenizer" | "shard-index" | "asset";
  bytes: number;
  sha256: string;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ModelManifest".
 */
export interface ModelManifest {
  version: 1;
  model: string;
  source: {
    repository: string;
    revision: string;
  };
  /**
   * @minItems 1
   */
  components: [ModelComponent, ...ModelComponent[]];
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "LocalEditingModel".
 */
export interface LocalEditingModel {
  variant:
    | "flux2-klein-4b"
    | "flux2-klein-9b"
    | "flux2-klein-base-4b"
    | "flux2-klein-base-9b"
    | "z-image-turbo"
    | "flux1-schnell"
    | "flux1-dev"
    | "flux1-krea-dev"
    | "flux1-fill-dev"
    | "flux1-kontext-dev"
    | "z-image"
    | "ernie-image"
    | "ernie-image-turbo";
  directory: string;
  manifest: ModelManifest;
  quantize?: 4 | 8;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "GenerateRequest".
 */
export interface GenerateRequest {
  model: string;
  outputPath: string;
  seed?: number;
  size?: ImageSize;
  prompt: string;
}
