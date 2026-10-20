import type { Refusal } from './types.ts';

/** A format version this SDK does not know yet; anything else that is not version 1 is invalid. */
export function newerVersion(value: unknown): number | undefined {
  const version = (value as { version?: unknown } | null)?.version;
  return typeof version === 'number' && Number.isSafeInteger(version) && version > 1 ? version : undefined;
}
/** A newer persisted format is refused unchanged, by the validators and readers alike. */
export const versionRefusal = <C extends 'ARTIFACT_VERSION_UNSUPPORTED' | 'PROFILE_VERSION_UNSUPPORTED' | 'MODEL_REGISTRATION_VERSION_UNSUPPORTED'>(code: C, message: string, version: number, subject?: string): Refusal<C> =>
  ({ status: 'refused', code, message, ...(subject === undefined ? {} : { subject }), details: { version } });
