/** A portable filename derived from authored session text, never interpreted as a path. */
export function exportName(session: string, image: number): string {
  const clean = session.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim();
  // Filesystems commonly limit a filename to 255 UTF-8 bytes, not characters.
  const encoder = new TextEncoder(); let name = '', bytes = 0;
  for (const character of clean) { const size = encoder.encode(character).length; if (bytes + size > 220) break; name += character; bytes += size; }
  name ||= 'PicPatch';
  return `${name} ${Math.max(1, Math.trunc(image))}.png`;
}
