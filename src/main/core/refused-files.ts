// A refused file (store-recovery-conventions): newer than this build reads, or unreadable. It is reported by its path
// and never changed; at launch every refused file is named together and PicPatch stops before writing anything.
import { message, UiError, type Message } from '../../shared/i18n/index.ts';

export interface RefusedFile { path: string; newer: boolean }
export const refusedNotice = (file: RefusedFile): Message => message(file.newer ? 'error.file_newer' : 'error.file_unreadable', { path: file.path });

export class RefusedFiles extends UiError {
  readonly files: RefusedFile[];
  constructor(files: RefusedFile[], options?: ErrorOptions) {
    const first = refusedNotice(files[0]!);
    super(first.key, first.values, options);
    this.files = files;
  }
}
export const refused = (path: string, newer: boolean, cause?: unknown) => new RefusedFiles([{ path, newer }], cause === undefined ? undefined : { cause });
/** Every refused file among several launch reads, as one error; other failures pass through. */
export function launchRefusals(errors: unknown[]): RefusedFiles | undefined {
  const files = errors.flatMap(error => error instanceof RefusedFiles ? error.files : []);
  return files.length ? new RefusedFiles(files) : undefined;
}
