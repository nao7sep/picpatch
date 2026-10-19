// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { Application } from '../../src/main/core/service.ts';
import { saveSettings } from '../../src/main/core/settings.ts';
import type { AppPaths } from '../../src/main/core/paths.ts';
import type { Bridge } from '../../src/shared/bridge.ts';
import type { Session } from '../../src/shared/session.ts';
import { App } from '../../src/renderer/src/App.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('generates, edits with references, branches and reopens through the real renderer and local worker', async () => {
  const cache = resolve('sdk/node_modules/.cache/picpatch-live');
  const config = JSON.parse(await readFile(join(cache, 'inference-config.json'), 'utf8'));
  const modelId = config.model.manifest.model;
  const artifacts = resolve('node_modules/.cache/picpatch-live/command-workflow');
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, 'session-'));
  const paths: AppPaths = { root, sessions: join(root, 'sessions'), config: join(root, 'config.json'), state: join(root, 'state.json'), backups: join(root, 'backups.sqlite3') };
  await saveSettings(paths.config, { version: 1, profile: { version: 1, engineDirectory: join(cache, 'managed-engine') }, registrations: { [modelId]: { version: 1, model: config.model } } });
  let change = () => {};
  const diagnostics: unknown[] = [];
  let app = await Application.open(paths, () => change(), () => {}, (level, message, details) => { if (level === 'error') diagnostics.push({ message, ...details }); });
  const created = await app.sessions.create('Offline command acceptance');
  await app.draft(created.id, { ...created.draft, modelIds: [modelId], width: 384, height: 384, seed: 42, parameters: { steps: 4 } });
  // Deterministic local reference images make this test independent of private photographs.
  const referencePaths = [join(root, 'blue.png'), join(root, 'yellow.png')];
  await sharp({ create: { width: 384, height: 384, channels: 3, background: '#176cbb' } }).png().toFile(referencePaths[0]!);
  await sharp({ create: { width: 384, height: 384, channels: 3, background: '#ffc526' } }).png().toFile(referencePaths[1]!);
  let ready = false;
  let flush: (() => Promise<unknown>) | undefined;
  const call: Bridge['call'] = async (action, raw) => {
    const p = raw as any;
    switch (action) {
      case 'locale': return { language: 'en', format: 'en' };
      case 'paneState': return p?.railWidth === undefined ? { railWidth: 264, optionsPane: false } : undefined;
      case 'layout': case 'modalState': return;
      case 'modelReadiness': return app.readiness();
      case 'overview': return { ...await app.overview(), resourcesBusy: false, locale: { language: 'en', format: 'en' }, systemDark: false };
      case 'get': return app.sessions.get(p.id);
      case 'focus': return app.queue.focus(p.id);
      case 'draft': return app.draft(p.id, p.draft);
      case 'import': return Promise.all(referencePaths.map(path => app.importImage(p.id, path)));
      case 'submit': return app.queue.submit(p.id, p.draft, p.samples);
      case 'ready': ready = true; return;
      default: throw new Error(`Unexpected bridge call: ${action}`);
    }
  };
  window.picpatch = { call, onChange: listener => { change = listener; return () => {}; }, onQueue: () => () => {}, onCommand: () => () => {}, onRequest: listener => { flush = () => listener({ kind: 'flush' }); }, droppedFile: () => { throw new Error('No native drop in this test'); } };
  Element.prototype.scrollIntoView ??= () => {};
  const field = () => screen.getByRole('textbox', { name: 'Command' }) as HTMLTextAreaElement;
  const command = async (text: string) => {
    fireEvent.change(field(), { target: { value: text } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run command' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 10_000 });
    const count = (await app.sessions.get(created.id)).runs.length;
    fireEvent.click(screen.getByRole('button', { name: 'Run command' }));
    await waitFor(async () => expect((await app.sessions.get(created.id)).runs.length).toBe(count + 1), { timeout: 10_000 });
    await app.queue.settled();
    const saved = await app.sessions.get(created.id), run = saved.runs.at(-1)!;
    expect(run.status, JSON.stringify({ issue: run.issue, diagnostics })).toBe('completed');
    expect(app.queue.busy()).toBe(false);
    const output = await app.sessions.imagePath(saved.id, run.id);
    expect(await sharp(output).metadata()).toMatchObject({ format: 'png', width: 384, height: 384 });
    expect(JSON.parse(await readFile(output.replace(/\.png$/, '-picpatchsdk.json'), 'utf8'))).toHaveProperty('seed', 42);
    await act(async () => change());
    await waitFor(() => expect(screen.queryByText('The target image is not ready. Wait, select another image, or choose New image.')).toBeNull(), { timeout: 5000 });
    console.log(JSON.stringify({ stage: count + 1, output }));
    return run;
  };
  try {
    render(<App />);
    await waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
    fireEvent.click(await screen.findByText('Offline command acceptance'));
    const original = await command('A studio photograph of a plain white ceramic teapot on a wooden table, soft daylight, neutral background.');
    fireEvent.click(screen.getByRole('button', { name: 'Add images' }));
    fireEvent.click(await screen.findByText('Reference photos'));
    await waitFor(() => expect(document.querySelectorAll('.chip.group img')).toHaveLength(2), { timeout: 5000 });
    const edited = await command('Keep the teapot and composition. Paint the teapot the blue of the first reference and its lid the yellow of the second reference.');
    expect(edited.parent).toBe(original.id); expect(edited.draft.references[0]!.images).toHaveLength(2);
    const firstResult = document.querySelectorAll('.print')[0] as HTMLElement;
    fireEvent.click(within(firstResult).getByRole('button', { name: 'Edit this result' }));
    await waitFor(async () => expect((await app.sessions.get(created.id)).draft.source).toBe(original.id));
    const branch = await command('Keep the original white teapot. Add a small green leaf beside it on the table.');
    expect(branch.parent).toBe(original.id);
    fireEvent.change(field(), { target: { value: 'Unsent instruction retained across reopening' } }); await act(async () => { await flush!(); });
    const before = await app.sessions.get(created.id);
    cleanup();
    app = await Application.open(paths, () => change());
    ready = false;
    render(<App />);
    await waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
    fireEvent.click(await screen.findByText('Offline command acceptance'));
    await waitFor(() => expect(field().value).toBe(before.draft.text));
    const reopened: Session = await app.sessions.get(created.id);
    expect(reopened.runs).toEqual(before.runs);
    expect(reopened.draft).toEqual(before.draft); expect(app.queue.busy()).toBe(false);
    expect(reopened.runs.map(run => run.parent)).toEqual([undefined, original.id, original.id]);
    for (const run of reopened.runs) expect(await sharp(await app.sessions.imagePath(created.id, run.id)).metadata()).toHaveProperty('format', 'png');
    console.log(JSON.stringify({ session: app.sessions.directory(created.id), reopened: true }));
  } finally {
    if (app.queue.busy()) { for (const active of [...app.queue.state.active]) await app.queue.cancel(active.sessionId, active.runId); await app.queue.settled(); }
    cleanup();
  }
}, 900_000);
