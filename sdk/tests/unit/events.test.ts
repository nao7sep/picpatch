import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readProfile, type SdkEvent, type ProgressEvent, type RuntimeConfiguration } from '../../src/index.ts';
import { diagnosticLifetime, withDiagnostics } from '../../src/diagnostics.ts';
import { emitProgress } from '../../src/operations.ts';
import packageInfo from '../../package.json' with { type: 'json' };

it('returns plain results and rejects the retired log option without creating a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'picpatch-events-'));
  try {
    const path = join(directory, 'profile.json'); await writeFile(path, '{"version":1}');
    const events: SdkEvent[] = [];
    expect(await readProfile(path, { onEvent: event => events.push(event) })).toEqual({ status: 'read', profile: { version: 1 } });
    // @ts-expect-error SDK logging is no longer a supported option.
    await expect(readProfile(path, { logPath: join(directory, 'operation.log') })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await readdir(directory)).toEqual(['profile.json']);
    expect(events.at(-1)?.name).toBe('operation.succeeded');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('emits startup once per lifetime with version and runtime configuration, without suppressing other callers', async () => {
  const configuration: RuntimeConfiguration = { backend: 'mflux' };
  const lifetime = diagnosticLifetime(configuration);
  const events: SdkEvent[] = [];
  const options = { onEvent: (event: SdkEvent) => events.push(event) };
  await Promise.all([withDiagnostics('one', options, async () => 1, lifetime), withDiagnostics('two', options, async () => 2, lifetime)]);
  const startup = events.filter(event => event.name === 'sdk.startup');
  expect(startup).toHaveLength(1);
  expect(startup[0]?.startup).toEqual({ sdk: 'picpatchsdk', version: packageInfo.version, runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch }, configuration: { backend: 'mflux' } });
  await withDiagnostics('other', options, async () => 3, diagnosticLifetime());
  expect(events.filter(event => event.name === 'sdk.startup')).toHaveLength(2);
  for (const event of events) {
    expect(event.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(event).toMatchObject({ type: 'event', name: expect.any(String), operationId: expect.any(String), stage: expect.any(String), message: expect.any(String) });
  }
});
it('emits debug counts only when explicitly enabled and leaves counted progress unchanged', async () => {
  for (const debug of [undefined, false, true]) {
    const events: SdkEvent[] = []; const progress: ProgressEvent[] = [];
    await withDiagnostics('test', { ...(debug === undefined ? {} : { debug }), onEvent: (event: SdkEvent) => events.push(event), onProgress: (event: ProgressEvent) => progress.push(event) }, async options => {
      emitProgress(options, { stage: 'editing', completed: 1, total: 1 });
    }, diagnosticLifetime());
    expect(events.filter(event => event.level === 'debug')).toHaveLength(debug ? 1 : 0);
    if (debug) expect(events.find(event => event.level === 'debug')).toMatchObject({ name: 'operation.progress', progress: { completed: 1, total: 1 } });
    expect(progress).toEqual([{ type: 'progress', stage: 'editing', completed: 1, total: 1 }]);
  }
  await expect(withDiagnostics('test', { debug: 'true' } as never, async () => 1)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
it('names refused outcomes separately from success', async () => {
  const events: SdkEvent[] = [];
  const result = { status: 'refused', code: 'OUTPUT_CONFLICT', effect: 'none' };
  expect(await withDiagnostics('test', { onEvent: (event: SdkEvent) => events.push(event) }, async () => result, diagnosticLifetime())).toBe(result);
  expect(events.map(event => event.name)).toEqual(['sdk.startup', 'operation.started', 'operation.refused']);
  expect(events.at(-1)?.refusal).toEqual({ code: 'OUTPUT_CONFLICT', effect: 'none' });
});
it('reports stages independently and throttles only real counts, preserving the final count', async () => {
  const events: SdkEvent[] = []; const progress: ProgressEvent[] = [];
  await withDiagnostics('test', { onEvent: (event: SdkEvent) => events.push(event), onProgress: (event: ProgressEvent) => progress.push(event) }, async options => {
    emitProgress(options, { stage: 'loading' });
    for (let completed = 0; completed <= 100; completed++) emitProgress(options, { stage: 'editing', completed, total: 100 });
  });
  expect(events.filter(event => event.name !== 'sdk.startup').map(event => event.stage)).toEqual(['started', 'loading', 'editing', 'succeeded']);
  expect(progress).toEqual([{ type: 'progress', stage: 'editing', completed: 0, total: 100 }, { type: 'progress', stage: 'editing', completed: 100, total: 100 }]);
});

it('emits startup once across repeated public editor calls and keeps nested operations in one stream', async () => {
  const { createEditor } = await import('../../src/client.ts');
  const editor = createEditor();
  const events: SdkEvent[] = [];
  try {
    // Planning fails before inference because this editor has no registered model.
    for (let index = 0; index < 2; index++) {
      await expect(editor.plan({ model: 'fixture', prompt: 'Fixture', outputPath: '/unused.png' }, { onEvent: event => events.push(event) })).rejects.toBeDefined();
    }
    expect(events.filter(event => event.name === 'sdk.startup')).toHaveLength(1);
    expect(events[0]?.startup?.configuration.backend).toBe('mflux');
    expect(events.filter(event => event.name === 'operation.failed')).toHaveLength(2);
  } finally { await editor.dispose(); }
  const nested: SdkEvent[] = [];
  await withDiagnostics('outer', { onEvent: (event: SdkEvent) => nested.push(event) }, options => withDiagnostics('inner', options, async () => 1), diagnosticLifetime());
  expect(nested.map(event => event.name)).toEqual(['sdk.startup', 'operation.started', 'operation.succeeded']);
});
