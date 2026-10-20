// The shared call contract from the SDK consistency review: one set of call options, one refusal
// shape, newer formats refused by validators as by readers, cause codes and startup delivery.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as storage from '../../src/storage.ts';
import { diagnosticLifetime, withDiagnostics } from '../../src/diagnostics.ts';
import { publishFile } from '../../src/images/publication.ts';
import { admissionIssues } from '../../src/admission.ts';
import { admissionRequest, validateEditRequest } from '../../src/validation.ts';
import { listModels, inspectEngine, inspectModels, inspectNativeEngine, prepareModel, readArtifactRecord, saveArtifact, validateModelRegistration, PicPatchSdkError, type ArtifactRecord, type ModelCapabilities, type SdkEvent } from '../../src/index.ts';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'picpatch-contract-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('delivers the startup record to the first call that listens, not the first call', async () => {
  const lifetime = diagnosticLifetime();
  await withDiagnostics('quiet', {}, async () => 1, lifetime);
  const events: SdkEvent[] = [];
  await withDiagnostics('listening', { onEvent: event => events.push(event) }, async () => 2, lifetime);
  await withDiagnostics('later', { onEvent: event => events.push(event) }, async () => 3, lifetime);
  expect(events.filter(event => event.name === 'sdk.startup').map(event => event.verb)).toEqual(['listening']);
});

it('takes one call-options object on every verb, apart from each verb’s own arguments', async () => {
  const progress = vi.fn();
  // One options object an app can hand to any call; no verb refuses another verb's setting.
  const call = { signal: new AbortController().signal, onEvent: () => {}, onProgress: progress, debug: false, timeoutMs: 60_000 };
  expect((await inspectEngine({ engineDirectory: directory }, call)).status).toMatch(/missing|unsupported/);
  expect((await inspectNativeEngine({ engineDirectory: directory }, call)).status).toMatch(/missing|unsupported/);
  expect((await inspectModels({ modelsDirectory: directory }, call)).models.length).toBeGreaterThan(0);
  await expect(readArtifactRecord(join(directory, 'absent.json'), call)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  // Engine verbs report stages, not counts: they accept onProgress and never call it.
  expect(progress).not.toHaveBeenCalled();
  // Each side refuses the other's keys, and unknown keys, so a misplaced setting fails loudly.
  await expect(inspectEngine({ engineDirectory: directory, signal: call.signal } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(inspectEngine({}, { engineDirectory: directory } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(inspectEngine({ unknown: true } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  // caller is record content, an argument of the verbs that write records, not a call option.
  await expect(readArtifactRecord(join(directory, 'record.json'), { caller: { name: 'App', version: '1' } } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('refuses newer formats in the validators exactly as the readers do', () => {
  expect(validateModelRegistration({ version: 3, model: {} })).toEqual({ status: 'refused', code: 'MODEL_REGISTRATION_VERSION_UNSUPPORTED', message: expect.any(String), details: { version: 3 } });
  expect(() => validateModelRegistration({ version: 0 })).toThrow(PicPatchSdkError);
});

it('names why model preparation failed, not the step', async () => {
  const id = listModels().find(model => model.acquisition === 'pinned')!.id;
  await expect(prepareModel(id, { modelsDirectory: directory })).rejects.toMatchObject({ code: 'MODEL_MISSING', kind: 'unavailable' });
  const external = listModels().find(model => model.acquisition === 'external' && model.runtime.name === 'mflux')!.id;
  await mkdir(join(directory, 'bundle'));
  await expect(prepareModel(external, { directory: join(directory, 'bundle') })).rejects.toMatchObject({ code: 'MODEL_BUNDLE_INCOMPLETE', kind: 'invalid' });
});

it('keeps an engine that is not there distinct from a missing file', () => {
  const missing = Object.assign(new Error('spawn'), { code: 'ENOENT' });
  expect(new PicPatchSdkError('WORKER_UNAVAILABLE', 'Could not run the worker.', { cause: missing }).code).toBe('ENGINE_MISSING');
  expect(new PicPatchSdkError('IMAGE_IO', 'Could not read.', { cause: missing }).code).toBe('FILE_NOT_FOUND');
  expect(new PicPatchSdkError('RUNTIME_FAILURE', 'Generation failed.').kind).toBe('unavailable');
});

it('publishes by rename on a volume without hard links, and still never replaces a file', async () => {
  vi.spyOn(storage, 'link').mockRejectedValue(Object.assign(new Error('Operation not supported'), { code: 'ENOTSUP' }));
  const staged = join(directory, 'staged.png'); const target = join(directory, 'target.png');
  await writeFile(staged, 'complete');
  await publishFile(staged, target);
  expect(await readFile(target, 'utf8')).toBe('complete');
  expect(await readdir(directory)).toEqual(['target.png']);
  await writeFile(staged, 'second');
  await expect(publishFile(staged, target)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(target, 'utf8')).toBe('complete');
});

it('leaves a record’s inputs out of a saved copy when asked', async () => {
  const image = join(directory, 'image.png');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toFile(image);
  const bytes = await readFile(image);
  const { createHash } = await import('node:crypto');
  const record: ArtifactRecord = { version: 1, writer: { name: 'picpatchsdk', version: '0.0.0' }, operation: 'generate', inputsIncluded: true, inputs: { prompt: 'private' },
    image: { filename: 'image.png', mimeType: 'image/png', size: { width: 2, height: 2 } }, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    model: 'test', modelRevision: 'rev', runtime: { name: 'test', version: '1' }, seed: 1, effectiveParameters: { negativePrompt: 'private' }, fingerprints: [] };
  const saved = await saveArtifact(image, join(directory, 'copy.png'), record, { includeInputs: false, sidecar: true });
  if (saved.status === 'refused') throw new Error(saved.code);
  expect(saved.record).toMatchObject({ inputsIncluded: false });
  expect(JSON.stringify(saved.record)).not.toContain('private');
  expect(await readFile(join(directory, 'copy-picpatchsdk.json'), 'utf8')).not.toContain('private');
  expect(await saveArtifact(image, join(directory, 'newer.png'), { ...record, version: 2 } as never)).toMatchObject({ status: 'refused', code: 'ARTIFACT_VERSION_UNSUPPORTED', details: { version: 2 } });
});

it.skipIf(process.platform === 'win32')('inspects a configured native executable in place of the managed one', async () => {
  const executable = join(directory, 'sd-cli');
  const { nativeRevision } = await import('../../src/runtime/engine/native-release.ts');
  await writeFile(executable, `#!/bin/sh\necho "stable-diffusion.cpp version test, commit ${nativeRevision.slice(0, 7)}"\n`); await chmod(executable, 0o755);
  const inspected = await inspectNativeEngine({ engineDirectory: directory, nativeExecutable: executable });
  if (inspected.status === 'unsupported') return;
  expect(inspected).toMatchObject({ status: 'ready', nativeExecutable: executable });
  expect(await inspectNativeEngine({ engineDirectory: directory, profile: { version: 1, nativeExecutable: join(directory, 'absent') } })).toMatchObject({ status: 'missing', code: 'ENGINE_MISSING' });
  await writeFile(executable, '#!/bin/sh\necho "stable-diffusion.cpp version test, commit 0000000"\n');
  expect(await inspectNativeEngine({ engineDirectory: directory, nativeExecutable: executable })).toMatchObject({ status: 'incompatible' });
});

it('says which engine verbs prepare each catalog entry', () => {
  for (const model of listModels()) expect(model.runtime.engine).toBe(model.runtime.name === 'stable-diffusion.cpp' ? 'native' : 'python');
});

const capabilities: ModelCapabilities = { model: 'm', textToImage: false, instructionEditing: true, sourceImageRequired: true, maskRequired: false, referenceRoles: ['style'], maxReferenceImages: 1, maskMode: 'none',
  parameters: { steps: { default: 4, minimum: 1, maximum: 8, integer: true } } };
it('reports every admission issue a window shows, and execution refuses with the first', () => {
  expect(admissionIssues({ operation: 'generate', parameters: { steps: 9 } }, capabilities).map(issue => issue.code)).toEqual(['GENERATION_UNSUPPORTED', 'PARAMETER_OUT_OF_RANGE']);
  const issues = admissionIssues({ operation: 'edit', maskImage: true, references: [{ id: 'a', role: 'subject', images: 0 }, { id: 'b', role: 'style', images: 2 }], parameters: { guidance: 3 } }, capabilities);
  expect(issues.map(issue => [issue.code, issue.subject])).toEqual([['SOURCE_REQUIRED', undefined], ['MASK_UNSUPPORTED', undefined], ['REFERENCE_ROLE_UNSUPPORTED', 'a'], ['REFERENCE_IMAGES_REQUIRED', 'a'], ['REFERENCE_LIMIT', undefined], ['PARAMETER_UNSUPPORTED', 'guidance']]);
  expect(admissionIssues({ operation: 'edit', sourceImage: true }, capabilities)).toEqual([]);
  const request = { model: 'm', instruction: 'Edit', sourceImage: '/a.png', outputPath: '/b.png', parameters: { steps: 99 } };
  expect(() => validateEditRequest(request, capabilities)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: admissionIssues(admissionRequest(request), capabilities)[0]!.message }));
});
