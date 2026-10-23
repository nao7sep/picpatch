export interface Size { width: number; height: number }
/** Source, overlay and pointer mapping share this one aspect-preserving fit. */
export function fitImage(image: Size, stage: Size): Size {
  const scale = Math.min(stage.width / image.width, stage.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}
export function imagePoint(client: { x: number; y: number }, bounds: { left: number; top: number; width: number; height: number }, image: Size) {
  return { x: (client.x - bounds.left) * image.width / bounds.width, y: (client.y - bounds.top) * image.height / bounds.height };
}
export function wipeCompatible(first: Size, second: Size) { return first.width === second.width && first.height === second.height; }
