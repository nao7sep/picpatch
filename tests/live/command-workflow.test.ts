import { Window } from 'happy-dom';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { Application } from '../../src/app/service.ts';
import { saveSettings } from '../../src/app/settings.ts';
import type { AppPaths } from '../../src/app/paths.ts';
import type { Bridge } from '../../src/shared/bridge.ts';
import type { Session } from '../../src/app/types.ts';

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
      case 'paneState': return { requestWidth: 400, sidebar: true };
      case 'layout': return;
      case 'overview': return { ...await app.overview(), locale: { language: 'en', format: 'en' }, systemDark: false };
      case 'get': return app.sessions.get(p.id);
      case 'draft': return app.draft(p.id, p.draft, p.selection);
      case 'import': return Promise.all(referencePaths.map(path => app.importImage(p.id, path)));
      case 'submit': return app.queue.submit(p.id, p.draft, p.samples);
      case 'ready': ready = true; return;
      default: throw new Error(`Unexpected bridge call: ${action}`);
    }
  };
  const browser = new Window();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'HTMLDialogElement', 'HTMLImageElement', 'Image', 'ResizeObserver', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'Node']) vi.stubGlobal(key, (browser as any)[key]);
  document.write((await readFile('src/renderer/index.html', 'utf8')).replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, ''));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {}, getImageData() {}, putImageData() {} } as never);
  window.picpatch = { call, onChange: listener => { change = listener; return () => {}; }, onCommand: () => () => {}, onRequest: listener => { flush = () => listener({ kind: 'flush' }); }, droppedFile: () => { throw new Error('No native drop in this test'); } };
  const field = (id: string) => document.getElementById(id)! as HTMLInputElement;
  const command = async (text: string) => {
    field('text').value = text; field('text').dispatchEvent(new Event('input'));
    expect(field('run').disabled).toBe(false);
    const count = (await app.sessions.get(created.id)).runs.length;
    field('run').click();
    await vi.waitFor(async () => expect((await app.sessions.get(created.id)).runs.length).toBe(count + 1), { timeout: 10_000 });
    await app.queue.settled();
    const saved = await app.sessions.get(created.id), run = saved.runs.at(-1)!;
    expect(run.status, JSON.stringify({ issue: run.issue, diagnostics })).toBe('completed');
    expect(app.queue.busy()).toBe(false);
    const output = await app.sessions.imagePath(saved.id, run.id);
    expect(await sharp(output).metadata()).toMatchObject({ format: 'png', width: 384, height: 384 });
    expect(JSON.parse(await readFile(output.replace(/\.png$/, '-picpatchsdk.json'), 'utf8'))).toHaveProperty('seed', 42);
    await vi.waitFor(() => expect(field('admission').textContent).not.toContain('not ready'), { timeout: 5000 });
    console.log(JSON.stringify({ stage: count + 1, output }));
    return run;
  };
  try {
    await import('../../src/renderer/main.ts');
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
    const original = await command('A studio photograph of a plain white ceramic teapot on a wooden table, soft daylight, neutral background.');
    field('addReference').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#references img')).toHaveLength(2), { timeout: 5000 });
    const edited = await command('Keep the teapot and composition. Paint the teapot the blue of the first reference and its lid the yellow of the second reference.');
    expect(edited.parent).toBe(original.id); expect(edited.draft.references[0]!.images).toHaveLength(2);
    (document.querySelector(`#results [data-key="${original.id}"]`) as HTMLElement).click();
    await vi.waitFor(async () => expect((await app.sessions.get(created.id)).draft.source).toBe(original.id));
    const branch = await command('Keep the original white teapot. Add a small green leaf beside it on the table.');
    expect(branch.parent).toBe(original.id);
    field('text').value = 'Unsent instruction retained across reopening'; field('text').dispatchEvent(new Event('input')); await flush!();
    const before = await app.sessions.get(created.id);
    app = await Application.open(paths, () => change());
    change();
    await vi.waitFor(() => expect(document.querySelector('#sessionList button')).not.toBeNull());
    (document.querySelector('#sessionList button') as HTMLElement).click();
    await vi.waitFor(() => expect(field('text').value).toBe(before.draft.text));
    const reopened: Session = await app.sessions.get(created.id);
    expect(reopened.runs).toEqual(before.runs); expect(reopened.selection).toEqual([branch.id]);
    expect(reopened.draft).toEqual(before.draft); expect(app.queue.busy()).toBe(false);
    expect(reopened.runs.map(run => run.parent)).toEqual([undefined, original.id, original.id]);
    for (const run of reopened.runs) expect(await sharp(await app.sessions.imagePath(created.id, run.id)).metadata()).toHaveProperty('format', 'png');
    console.log(JSON.stringify({ session: app.sessions.directory(created.id), reopened: true }));
  } finally {
    if (app.queue.busy()) { const active = app.queue.state.active; if (active) await app.queue.cancel(active.sessionId, active.runId); await app.queue.settled(); }
    window.dispatchEvent(new Event('pagehide')); await browser.happyDOM.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
}, 900_000);
