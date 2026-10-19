export interface Size { width: number; height: number }
export function imagePoint(client: { x: number; y: number }, bounds: { left: number; top: number; width: number; height: number }, image: Size) {
  return { x: (client.x - bounds.left) * image.width / bounds.width, y: (client.y - bounds.top) * image.height / bounds.height };
}
export function wipeCompatible(first: Size, second: Size) { return first.width === second.width && first.height === second.height; }
