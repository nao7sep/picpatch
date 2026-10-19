export interface Size { width: number; height: number }
export function fitScale(viewport: Size, first: Size, second?: Size): number {
  const width = first.width + (second ? second.width + 12 : 0);
  const height = Math.max(first.height, second?.height ?? 0);
  return Math.max(0.01, Math.min((viewport.width - 32) / width, (viewport.height - 32) / height, 1));
}
export function imagePoint(client: { x: number; y: number }, bounds: { left: number; top: number; width: number; height: number }, image: Size) {
  return { x: (client.x - bounds.left) * image.width / bounds.width, y: (client.y - bounds.top) * image.height / bounds.height };
}
export function wipeCompatible(first: Size, second: Size) { return first.width === second.width && first.height === second.height; }
