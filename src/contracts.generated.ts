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
  maxReferenceImages?: number;
  maskMode: "none" | "native" | "composite";
  size?: {
    widthMultiple: number;
    heightMultiple: number;
    maxWidth?: number;
    maxHeight?: number;
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
}
/**
 * This interface was referenced by `EditRequestContract`'s JSON-Schema
 * via the `definition` "ProgressEvent".
 */
export interface ProgressEvent {
  type: "progress";
  verb: "edit";
  stage: "preparing" | "loading" | "editing" | "saving";
  message: string;
  completed?: number;
  total?: number;
}
