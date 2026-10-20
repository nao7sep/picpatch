// The one sharp import of the SDK. libvips keeps recently read files open for reuse; on Windows an
// open file cannot be deleted or renamed, so private copies could not be cleaned up. Files are
// therefore never held between operations; decoded-operation caching is unaffected.
import sharp from 'sharp';
sharp.cache({ files: 0 });
export default sharp;
export type { Metadata, Sharp } from 'sharp';
