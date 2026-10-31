// The identity header every PicPatch file carries (file-identity-conventions): `format` says what the file is,
// `writer` which program and release serialized it. Readers check `format` alone and never read `writer`.
// Pure, so the window entry and the app's worker threads share it.
import packageInfo from '../package.json' with { type: 'json' };

/** Every file of the product is owned by PicPatch, whichever package writes it. Kinds are lowercase kebab-case. */
export const fileOwner = 'picpatch' as const;
/** The one format version each kind is read and written at. */
export const fileVersion = 1 as const;
export type FileKind = 'config' | 'state' | 'session' | 'records' | 'backups' | 'sidecar' | 'profile' | 'model-registration' | 'model-manifest' | 'engine-record';
export type FileFormat<K extends FileKind = FileKind> = { owner: typeof fileOwner; kind: K; version: typeof fileVersion };
export interface FileProgram { name: string; version: string }
export interface FileWriter extends FileProgram { caller?: FileProgram }
export interface FileHeader<K extends FileKind = FileKind> { format: FileFormat<K>; writer: FileWriter }
export type HeaderCheck = { status: 'current' } | { status: 'newer'; version: number } | { status: 'unreadable' };

/** The SDK as writer, naming the program it writes for only when that program identified itself. */
export const sdkWriter = (caller?: FileProgram): FileWriter => ({ name: packageInfo.name, version: packageInfo.version, ...(caller ? { caller: { name: caller.name, version: caller.version } } : {}) });
export const fileHeader = <K extends FileKind>(kind: K, writer: FileWriter): FileHeader<K> => ({ format: { owner: fileOwner, kind, version: fileVersion }, writer: structuredClone(writer) });
/** The header first, then the content; content never holds `format` or `writer` itself. */
export const withFileHeader = <K extends FileKind, T extends object>(kind: K, writer: FileWriter, content: T): FileHeader<K> & T => ({ ...fileHeader(kind, writer), ...content });

/** Owner and kind must match exactly; a version above this build's is newer and left untouched. Other keys inside `format` are ignored. */
export function checkFileHeader(value: unknown, kind: FileKind): HeaderCheck {
  const format = value && typeof value === 'object' && !Array.isArray(value) ? (value as { format?: unknown }).format : undefined;
  if (!format || typeof format !== 'object' || Array.isArray(format)) return { status: 'unreadable' };
  const { owner, kind: found, version } = format as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof found !== 'string' || !Number.isSafeInteger(version) || (version as number) < 1) return { status: 'unreadable' };
  if (owner !== fileOwner || found !== kind) return { status: 'unreadable' };
  return version === fileVersion ? { status: 'current' } : { status: 'newer', version: version as number };
}
/** The content alone, for a reader that has checked the header. */
export function fileContent<T>(value: object): T {
  const { format: _format, writer: _writer, ...content } = value as Record<string, unknown>;
  return content as T;
}
