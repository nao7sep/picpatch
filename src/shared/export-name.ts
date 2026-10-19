/** A portable filename derived from authored session text, never interpreted as a path. */
export function exportName(session: string, image: number): string {
  const name = session.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'PicPatch';
  return `${name} ${Math.max(1, Math.trunc(image))}.png`;
}
