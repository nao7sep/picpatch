/* Generated from protocol/contracts.schema.json. Run npm run contracts:generate. */

/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "SidecarOutcome".
 */
export type SidecarOutcome =
  | {
      status: "saved";
      path: string;
    }
  | {
      status: "failed";
      path: string;
      code:
        "OUTPUT_CONFLICT" | "OUTPUT_IO" | "FILE_NOT_FOUND" | "PERMISSION_DENIED" | "DISK_FULL" | "IO_ERROR" | "TIMEOUT";
      message: string;
      effect: "none" | "unknown";
    };

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
  parameters?: SamplingParameters;
  sidecar?: SidecarOptions;
  outpaint?: OutpaintCanvas;
  control?: StructuralControl;
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
  /**
   * Omitted means prompt grouping; dedicated conditioning requires a compatible prepared selection.
   */
  conditioning?: "prompt" | "identity" | "appearance";
  /**
   * PhotoMaker identity class replacing the instruction placeholder {group-id}.
   */
  className?: "man" | "woman" | "girl" | "boy";
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
 * via the `definition` "SamplingParameters".
 */
export interface SamplingParameters {
  steps?: number;
  guidance?: number;
  negativePrompt?: string;
  scheduler?: string;
  sampler?: string;
  /**
   * Edit-only denoising strength. Lower values retain more source influence; zero still encodes/decodes and is not a pixel-preserving no-op. Unsupported for generation.
   */
  strength?: number;
  /**
   * Edit-only conditioning control for the corresponding advertised method.
   */
  identityStyleStrength?: number;
  /**
   * Edit-only conditioning control for the corresponding advertised method.
   */
  appearanceStrength?: number;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "SidecarOptions".
 */
export interface SidecarOptions {
  /**
   * Explicitly retain prompt/instruction, negative prompt and path-free input descriptions. False by default.
   */
  includeInputs?: boolean;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "OutpaintCanvas".
 */
export interface OutpaintCanvas {
  size: ImageSize;
  left: number;
  top: number;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "StructuralControl".
 */
export interface StructuralControl {
  image: string;
  kind: "canny";
  strength?: number;
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
  parameters?: SamplingParameters;
  sidecar?: SidecarOptions;
  outpaint?: OutpaintCanvas;
  control?: StructuralControl;
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
  /**
   * none: unsupported; native: trained mask conditioning; composite: output-only blending; latent-composite: source latent blending plus final pixel compositing.
   */
  maskMode: "none" | "native" | "composite" | "latent-composite";
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
  referenceConditioning?: "ordered-images-with-role-prompt" | "pooled-identity" | "appearance-embedding";
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
  /**
   * Limit on all conditioning images together: source plus grouped references. Masks are excluded.
   */
  maxConditioningImages?: number;
  parameters?: ParameterCapabilities;
  /**
   * SDK canvas expansion through this model mask workflow; preservation follows maskMode.
   */
  outpainting?: boolean;
  loraFormats?: ("sd-unet-safetensors" | "mflux-lora-safetensors")[];
  controlKinds?: "canny"[];
}
/**
 * Absent controls are unsupported. Descriptors apply to every advertised operation of this model.
 *
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ParameterCapabilities".
 */
export interface ParameterCapabilities {
  steps?: {
    default: number;
    minimum: number;
    maximum?: number;
    integer?: boolean;
  };
  guidance?: {
    default: number;
    minimum: number;
    maximum?: number;
    integer?: boolean;
  };
  scheduler?: {
    default: string;
    /**
     * @minItems 1
     */
    values: [string, ...string[]];
  };
  negativePrompt?: {
    default?: string;
    requiresGuidanceAbove?: number;
    requiredForGuidanceAbove?: number;
  };
  sampler?: {
    default: string;
    /**
     * @minItems 1
     */
    values: [string, ...string[]];
  };
  /**
   * Denoising strength for edit operations only; never a generation default. Semantics and bounds are model-specific.
   */
  strength?: {
    default: number;
    minimum: number;
    maximum?: number;
    integer?: boolean;
    /**
     * When true, the minimum itself is not supported.
     */
    minimumExclusive?: boolean;
  };
  /**
   * Edit-only conditioning control; unsupported unless advertised.
   */
  identityStyleStrength?: {
    default: number;
    minimum: number;
    maximum?: number;
    integer?: boolean;
  };
  /**
   * Edit-only conditioning control; unsupported unless advertised.
   */
  appearanceStrength?: {
    default: number;
    minimum: number;
    maximum?: number;
    integer?: boolean;
  };
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
  effectiveParameters: SamplingParameters;
  sidecar?: SidecarOutcome;
  outpaint?: OutpaintGeometry;
  conditioning?: ConditioningProvenance;
  loras?: LoraProvenance[];
  control?: ControlProvenance;
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
 * via the `definition` "OutpaintGeometry".
 */
export interface OutpaintGeometry {
  size: ImageSize;
  left: number;
  top: number;
  sourceSize: ImageSize;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ConditioningProvenance".
 */
export interface ConditioningProvenance {
  method: "photomaker-v1" | "ip-adapter" | "ip-adapter-plus";
  assets: {
    role: "photoMaker" | "ipAdapter" | "clipVision";
    filename: string;
    sha256: string;
  }[];
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "LoraProvenance".
 */
export interface LoraProvenance {
  filename: string;
  sha256: string;
  scale: number;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ControlProvenance".
 */
export interface ControlProvenance {
  kind: "canny";
  strength: number;
  asset: {
    filename: string;
    sha256: string;
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
    | "ernie-image-turbo"
    | "qwen-image"
    | "qwen-image-edit-2511"
    | "qwen-image-2.1"
    | "sd15"
    | "sdxl"
    | "sd15-inpaint"
    | "sdxl-inpaint"
    | "sdxl-photomaker-v1"
    | "sd15-ip-adapter"
    | "sdxl-ip-adapter"
    | "sd15-ip-adapter-plus"
    | "sdxl-ip-adapter-plus";
  directory: string;
  manifest: ModelManifest;
  quantize?: 4 | 8;
  /**
   * Native checkpoint path relative to the prepared model directory.
   */
  checkpoint?: string;
  /**
   * Optional native VAE path relative to the prepared model directory.
   */
  vae?: string;
  /**
   * Prepared native auxiliary weight path relative to the model directory.
   */
  photoMaker?: string;
  /**
   * Prepared native auxiliary weight path relative to the model directory.
   */
  ipAdapter?: string;
  /**
   * Prepared native auxiliary weight path relative to the model directory.
   */
  clipVision?: string;
  /**
   * @minItems 1
   */
  loras?: [LocalLora, ...LocalLora[]];
  controlNet?: LocalControlNet;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "LocalLora".
 */
export interface LocalLora {
  path: string;
  scale?: number;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "LocalControlNet".
 */
export interface LocalControlNet {
  path: string;
  kind: "canny";
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
  parameters?: SamplingParameters;
  sidecar?: SidecarOptions;
  control?: StructuralControl;
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ArtifactRecord".
 */
export interface ArtifactRecord {
  version: 1;
  operation: "edit" | "generate";
  inputsIncluded: boolean;
  image: {
    mimeType: "image/png";
    size: ImageSize;
    /**
     * Filename only, without directory information.
     */
    filename: string;
  };
  /**
   * SHA-256 of the final PNG file bytes, not decoded pixels or the record.
   */
  sha256: string;
  /**
   * Length of the final PNG file in bytes.
   */
  bytes: number;
  model: string;
  modelRevision: string;
  runtime: {
    name: string;
    version: string;
  };
  seed: number;
  effectiveParameters: SamplingParameters;
  inputs?: {
    prompt?: string;
    instruction?: string;
    references?: {
      id: string;
      role: "subject" | "object" | "style" | "background";
      /**
       * @minItems 1
       *
       * Items: Filename only, without directory information.
       */
      images: [string, ...string[]];
      /**
       * Omitted means prompt grouping; dedicated conditioning requires a compatible prepared selection.
       */
      conditioning?: "prompt" | "identity" | "appearance";
      /**
       * PhotoMaker identity class replacing the instruction placeholder {group-id}.
       */
      className?: "man" | "woman" | "girl" | "boy";
    }[];
    /**
     * Path-free input geometry; control map precedes source, mask and references when present.
     */
    geometry?: {
      originalSize: ImageSize;
      orientedSize: ImageSize;
      scaledSize: ImageSize;
      preparedSize: ImageSize;
      crop: {
        left: number;
        top: number;
      };
      /**
       * Filename only, without directory information.
       */
      filename: string;
    }[];
    /**
     * Filename only, without directory information.
     */
    sourceImage?: string;
    /**
     * Filename only, without directory information.
     */
    maskImage?: string;
    /**
     * Filename only, without directory information.
     */
    controlImage?: string;
  };
  outpaint?: OutpaintGeometry;
  conditioning?: ConditioningProvenance;
  loras?: LoraProvenance[];
  control?: ControlProvenance;
  writer: {
    name: "picpatchsdk";
    version: string;
  };
  caller?: {
    name: string;
    version: string;
  };
  /**
   * Original encoded input file bytes, before normalization; ordered by preparation.
   */
  fingerprints: {
    role: "source" | "mask" | "reference" | "control";
    sha256: string;
    bytes: number;
  }[];
}
