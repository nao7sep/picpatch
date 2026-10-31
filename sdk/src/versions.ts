import type { Refusal } from './types.ts';

/** A newer persisted format is refused unchanged, by the validators and readers alike. */
export const versionRefusal = <C extends 'ARTIFACT_VERSION_UNSUPPORTED' | 'PROFILE_VERSION_UNSUPPORTED' | 'MODEL_REGISTRATION_VERSION_UNSUPPORTED'>(code: C, message: string, version: number, subject?: string): Refusal<C> =>
  ({ status: 'refused', code, message, ...(subject === undefined ? {} : { subject }), details: { version } });
