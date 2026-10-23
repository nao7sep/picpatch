import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { PicPatchSdkError, errorCodes, isPicPatchSdkError, inspectModel } from '../../src/index.ts';
import { sdkError } from '../../src/errors.ts';
import { validateResponse } from '../../src/worker/protocol.ts';

it('classifies actual filesystem causes and keeps the local original cause', async () => {
  const cause = await readFile('/picpatch-fixture-missing/absent').catch(error => error);
  const error = new PicPatchSdkError('IMAGE_IO', 'Cannot read image.', { cause, subject: '/picpatch-fixture-missing/absent' });
  expect(error).toMatchObject({ code: 'FILE_NOT_FOUND', kind: 'unavailable', effect: 'none', cause });
  expect(error.cause).toBe(cause);
  await expect(inspectModel('/picpatch-fixture-missing/absent')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', kind: 'unavailable', effect: 'none' });
});
it('round-trips errors through JSON and another realm without class identity or private cause text', () => {
  const cause = new Error('private token sentinel');
  const original = new PicPatchSdkError('TERMINATION_FAILED', 'Cannot confirm closure.', { cause, effect: 'unknown', details: { recoveryDirectory: '/owned/staging' } });
  const bytes = JSON.stringify(original);
  const value: unknown = runInNewContext('JSON.parse(input)', { input: bytes });
  expect(value).not.toBeInstanceOf(PicPatchSdkError);
  expect(isPicPatchSdkError(value)).toBe(true);
  expect(bytes).not.toContain('private token sentinel');
  expect(sdkError(value).toJSON()).toMatchObject({ code: original.code, kind: original.kind, effect: original.effect, details: original.details });
});
it('rejects unknown codes, inconsistent kinds/effects and malformed details', () => {
  const value = new PicPatchSdkError('CANCELLED', 'Cancelled.').toJSON();
  for (const change of [{ code: 'OTHER' }, { code: '__proto__' }, { kind: 'internal' }, { effect: 'success' }, { details: null }, { details: { diagnostic: 'private' } }, { details: { diagnostic: { phase: 'loading', causes: [{ kind: 'Exception', locals: 'private' }] } } }, { details: { diagnostic: { phase: 'loading', causes: [{ kind: 'Exception', message: 42 }] } } }]) {
    expect(isPicPatchSdkError({ ...value, ...change })).toBe(false);
  }
  expect(Object.isFrozen(errorCodes)).toBe(true);
  expect(Object.values(errorCodes).every(kind => ['invalid', 'unavailable', 'cancelled', 'internal'].includes(kind))).toBe(true);
});
it('validates worker error fields and preserves effect rather than inferring it from the stage', () => {
  const error = new PicPatchSdkError('PERMISSION_DENIED', 'Unavailable.', { effect: 'none', details: { diagnostic: { phase: 'saving', causes: [{ kind: 'PermissionError', errno: 13 }] } } }).toJSON();
  expect(() => validateResponse({ version: 1, id: 2, type: 'error', error })).not.toThrow();
  expect(() => validateResponse({ version: 1, id: 2, type: 'error', error: { ...error, kind: 'invalid' } })).toThrow();
  expect(sdkError(new Error('private unknown'))).toMatchObject({ code: 'INTERNAL', kind: 'internal', effect: 'none' });
});
