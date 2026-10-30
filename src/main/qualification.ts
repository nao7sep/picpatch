import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modalLayoutProblems } from './qualification-layout.ts';
import { isAbsolute } from 'node:path';
import type { Application } from './core/service.ts';
/** Explicit automated package qualification; never reached during ordinary launch. */
export async function qualifyInference(service: Application, configuration: string, uv: string): Promise<void> {
  if (!isAbsolute(configuration)) throw new Error('Qualification configuration must be absolute.');
  const config = JSON.parse(await readFile(configuration, 'utf8'));
  // The packaged uv must run; its version is pinned and checksummed where it is staged.
  const version = await promisify(execFile)(uv, ['--version'], { timeout: 5000 });
  if (!version.stdout.startsWith('uv ')) throw new Error('The bundled setup tool did not run.');
  await service.preferences({ nativeExecutable: config.executable });
  await service.prepare('sd15', config.directory, config.sd15Checkpoint);
  const session = await service.sessions.create();
  const draft = { ...session.draft, modelIds: ['sd15'], text: 'A ceramic cup on a wooden table, studio photograph', width: 512, height: 512, seed: 42, parameters: { steps: 4 } };
  await service.queue.submit(session.id, draft, 1);
  await service.queue.settled();
  const result = (await service.sessions.get(session.id)).runs[0];
  if (result?.status !== 'completed' || !result.output || result.notices?.length || service.queue.state.paused) throw new Error(`Packaged inference failed: ${JSON.stringify(result?.issue ?? service.queue.state)}`);
}

/** Hidden Chromium qualification uses real font/layout metrics, not simulated DOM geometry. */
export async function qualifyLocalization(window: import('electron').BrowserWindow, root: string, command: (id: string) => void): Promise<void> {
  const { languages } = await import('../shared/i18n/index.ts');
  const run = (script: string) => window.webContents.executeJavaScript(`(async () => {
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const front = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1);
    const wait = async (test, what) => { const deadline = Date.now() + 5000; while (!test()) { if (Date.now() > deadline) throw new Error(what); await new Promise(resolve => setTimeout(resolve, 20)); } };
    const clipped = scope => [...scope.querySelectorAll('button, .menu-item, .chip-button, .segmented label, .tab-strip button')].filter(control => control.getClientRects().length && control.scrollWidth > control.clientWidth + 2).map(control => control.textContent.trim());
    ${script}
  })()`);
  for (const [language] of languages) {
    await run(`
      await window.picpatch.call('preferences', { language: ${JSON.stringify(language)}, engineDirectory: ${JSON.stringify(root + '/engine')}, modelsDirectory: ${JSON.stringify(root + '/models')} });
      await wait(() => document.documentElement.lang === ${JSON.stringify(language)}, 'Language did not update.');`);
    for (const theme of ['light', 'dark'] as const) for (const [width, height] of [[1280, 850], [1024, 700]]) {
      const { nativeTheme } = await import('electron'); nativeTheme.themeSource = theme;
      window.setContentSize(width!, height!);
      const where = `${language}:${theme}:${width}x${height}`;
      await run(`
        await settle();
        if (innerWidth !== ${width} || innerHeight !== ${height}) throw new Error('Unexpected qualification viewport: ' + innerWidth + 'x' + innerHeight);
        if (matchMedia('(prefers-color-scheme: dark)').matches !== ${theme === 'dark'}) throw new Error('Qualification theme did not apply.');
        while (front()) { front().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); }
        const failures = [];
        if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('window: horizontal overflow');
        failures.push(...clipped(document.querySelector('.shell')).map(text => 'window: clipped ' + text));
        document.querySelector('.rail-top [aria-haspopup="menu"]').click(); await settle();
        const menu = document.querySelector('.menu-popover');
        if (!menu || menu.getBoundingClientRect().bottom > innerHeight + 1) failures.push('menu: not visible');
        else failures.push(...clipped(menu).map(text => 'menu: clipped ' + text));
        menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
        if (failures.length) throw new Error(${JSON.stringify(where)} + ': ' + failures.join('; '));`);
      for (const surface of ['settingsButton', 'manage', 'setup', 'shortcutsButton', 'about', 'message'] as const) {
        const pending = surface === 'message' ? window.webContents.executeJavaScript(`window.picpatch.call('delete', { id: 'qualification-cancel-only' })`).catch(() => false) : undefined;
        if (surface !== 'message') command(surface);
        await run(`
          await wait(() => front(), 'Modal did not open: ${surface}');
          const dialog = front();
          if (${surface === 'manage'}) { const select = dialog.querySelector('select'); const native = [...select.options].find(option => option.value.includes('sdxl')); if (native) { select.value = native.value; select.dispatchEvent(new Event('change', { bubbles: true })); } }
          const failures = await (${modalLayoutProblems.toString()})(dialog, settle, innerHeight);
          dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(() => !document.contains(dialog), 'Modal did not close: ${surface}');
          if (failures.length) throw new Error(${JSON.stringify(where + ':' + surface)} + ': ' + failures.join('; '));`);
        if (pending && await pending !== false) throw new Error('Qualification must cancel deletion.');
      }
    }
  }
}

/** Geometry is measured in the real hidden renderer; records remain literal. */
export async function qualifyLogs(window: import('electron').BrowserWindow, workspace: import('electron').BrowserWindow): Promise<void> {
  const { languages } = await import('../shared/i18n/index.ts');
  for (const [language] of languages) for (const theme of ['light', 'dark']) {
    await workspace.webContents.executeJavaScript(`window.picpatch.call('preferences', {language: ${JSON.stringify(language)}, theme: ${JSON.stringify(theme)}})`);
    for (const [width, height] of [[765, 480], [1100, 720]]) {
      window.setContentSize(width!, height!);
      await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000;
        while (document.documentElement.lang !== ${JSON.stringify(language)} || matchMedia('(prefers-color-scheme: dark)').matches !== ${JSON.stringify(theme === 'dark')} || !document.querySelector('.records-shell')) {
          if (Date.now() > deadline) throw new Error('Records appearance did not settle.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const list = document.querySelector('.records-rows'), detail = document.querySelector('.records-detail');
        if (list.clientHeight < 100 || detail.clientWidth < 300 || document.documentElement.scrollWidth > innerWidth + 1) throw new Error('Records regions do not fit.');
        for (const control of document.querySelectorAll('button,select,input')) if (control.scrollWidth > control.clientWidth + 2) throw new Error('Records control clips: ' + (control.textContent || control.getAttribute('aria-label')));
      })()`);
    }
  }
}
/**
 * A smoke run, once the window is ready: the packaged renderer must enforce its content security policy, then the
 * requested localization, inference, Records and mask qualifications run. Returns the process exit code.
 */
export async function runSmoke(options: {
  window: import('electron').BrowserWindow; packaged: boolean;
  localization?: { root: string; command: (id: string) => void; openLogs: () => Promise<import('electron').BrowserWindow>; closeLogs: () => void };
  inference?: { service: Application; configuration: string; uv: string };
  records?: { records: import('./core/records.ts').Records; openLogs: () => Promise<import('electron').BrowserWindow> };
  mask?: { service: Application; root: string };
}): Promise<number> {
  const { window, localization, inference, records, mask } = options;
  if (options.packaged && !await window.webContents.executeJavaScript("(() => { try { new Function(''); return false; } catch { return true; } })()")) {
    console.error('The packaged renderer runs without its content security policy.'); return 1;
  }
  try {
    if (localization) { await qualifyLocalization(window, localization.root, localization.command); await qualifyLogs(await localization.openLogs(), window); localization.closeLogs(); }
    if (inference) await qualifyInference(inference.service, inference.configuration, inference.uv);
    // The live checks print their verdict as one line for the test that runs them.
    if (records) { const result = await qualifyRecordsLive(records.records, records.openLogs); process.stdout.write(`RECORDS-CHECK ${JSON.stringify(result)}\n`); if (!result.pass) return 1; }
    if (mask) { const result = await qualifyMaskCanvas(window, mask.service, mask.root); process.stdout.write(`MASK-CHECK ${JSON.stringify(result)}\n`); if (!result.pass) return 1; }
  } catch (error) { console.error(error); return 1; }
  return 0;
}

/** Page-side helpers for the live checks, kept in the page as `rc`; frames are waited for, never timed out. */
const PAGE_HELPERS = `
window.rc ??= (() => {
  const rc = {
    longest: 0,
    frame: () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))),
    async until(done) { while (!done()) await rc.frame(); },
  };
  let last = performance.now();
  const tick = now => { rc.longest = Math.max(rc.longest, now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return rc;
})();
true;`;

/**
 * The real Records window, hidden, over this run's data folder: 10,000 records are stored through the app's own
 * records thread, then three more each second while the window is driven. Its script reads only what Chromium
 * reports (scroll offsets, heights and the rows' rectangles) and waits frame by frame for each state it needs.
 * Returns the verdict, printed by the caller as one `RECORDS-CHECK {json}` line.
 */
export async function qualifyRecordsLive(records: Pick<import('./core/records.ts').Records, 'write' | 'query'>, openLogs: () => Promise<import('electron').BrowserWindow>, seed = 10_000) {
  for (let n = 1; n <= seed; n++) records.write('info', `seed record ${n}`, { n });
  // A read is answered after every write posted before it.
  await records.query({ current: true, level: 'all', search: '' });
  const window = await openLogs();
  let live = 0;
  const timer = setInterval(() => records.write('info', `live record ${++live}`, { n: live }), 333);
  try { return await recordsChecks(window, records, seed); } finally { clearInterval(timer); }
}

async function recordsChecks(window: import('electron').BrowserWindow, records: Pick<import('./core/records.ts').Records, 'query'>, seed: number) {
  const page = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script) as Promise<T>;
  /** Every stored record's id in this launch, newest first, as the database orders them. */
  const databaseOrder = async () => {
    const ids: number[] = [];
    for (let before: number | undefined; ;) {
      const result = await records.query({ current: true, level: 'all', search: '', ...(before === undefined ? {} : { before }) });
      ids.push(...result.records.map(record => record.id));
      if (!result.more || !result.records.length) return ids;
      before = result.records.at(-1)!.id;
    }
  };
  const contiguousIn = (order: number[], ids: number[]) => { const start = order.indexOf(ids[0] ?? -1); return start >= 0 && ids.every((id, index) => order[start + index] === id); };
  await page(PAGE_HELPERS);
  await page(`Object.assign(rc, {
    scroll: () => document.querySelector('.records-rows'),
    rows: () => [...document.querySelectorAll('[role="option"]')].map(option => ({
      pos: Number(option.getAttribute('aria-posinset')), size: Number(option.getAttribute('aria-setsize')), id: Number(option.dataset.recordId),
      text: option.querySelector('.record-text').textContent, top: option.getBoundingClientRect().top, bottom: option.getBoundingClientRect().bottom,
    })).sort((x, y) => x.pos - y.pos),
    size: () => rc.rows()[0]?.size ?? 0,
    visible: () => { const box = rc.scroll().getBoundingClientRect(); return rc.rows().filter(row => row.top >= box.top && row.bottom <= box.bottom); },
    reading: () => rc.scroll().getAttribute('aria-busy') === 'true',
    detail: () => document.querySelector('.records-detail pre')?.textContent ?? null,
    snapshot: () => ({ scrollTop: rc.scroll().scrollTop, first: rc.visible()[0], size: rc.size(), selected: Number(document.querySelector('[role="option"][aria-selected="true"]')?.dataset.recordId ?? 0) || null, detail: rc.detail() }),
  }); true;`);

  // (a) The first page: newest first, in the database's order, filling more than the window.
  const first = await page<{ size: number; ids: number[]; height: number; content: number }>(`(async () => {
    await rc.until(() => rc.size() > 0 && !rc.reading());
    return { size: rc.size(), ids: rc.rows().map(row => row.id), height: rc.scroll().clientHeight, content: rc.scroll().scrollHeight };
  })()`);
  const a = { pass: first.size >= 100 && first.content > first.height && contiguousIn(await databaseOrder(), first.ids), size: first.size };

  // (c) At the top, a record stored now appears at the top on its own.
  const top = await page<{ pos: number; text: string }>(`(async () => {
    const before = rc.rows()[0].id;
    await rc.until(() => rc.rows()[0].id !== before && rc.rows()[0].text.startsWith('live record'));
    return rc.rows()[0];
  })()`);
  const c = { pass: top.pos === 1, text: top.text };

  // (d) Scrolled down with a record selected, five stored records move nothing; back at the top they are there,
  // and the selection and its detail stayed.
  type Snapshot = { scrollTop: number; first: { id: number; top: number }; size: number; selected: number | null; detail: string | null };
  const held = await page<{ before: Snapshot; after: Snapshot; back: Snapshot }>(`(async () => {
    const scroll = rc.scroll();
    scroll.scrollTop = 3000;
    await rc.until(() => scroll.scrollTop === 3000);
    await rc.until(() => !rc.reading());
    await rc.frame();
    const target = rc.visible()[1];
    document.querySelector('[data-record-id="' + target.id + '"]').click();
    await rc.until(() => rc.detail()?.includes(target.text));
    await rc.frame();
    const before = rc.snapshot();
    let stored = 0;
    const stop = window.picpatchLogs.onRecordsChanged(() => { stored++; });
    await rc.until(() => stored >= 5);
    stop();
    await rc.frame();
    const after = rc.snapshot();
    scroll.scrollTop = 0;
    await rc.until(() => rc.size() > before.size && rc.rows()[0].pos === 1);
    await rc.frame();
    const back = rc.snapshot();
    // The selected row is out of the rendered range at the top; it is looked for half a screen at a time.
    const selected = () => document.querySelector('[data-record-id="' + before.selected + '"]');
    while (!selected()) { scroll.scrollTop += scroll.clientHeight / 2; await rc.frame(); }
    back.selected = selected().getAttribute('aria-selected') === 'true' ? before.selected : null;
    return { before, after, back };
  })()`);
  const same = (x: Snapshot, y: Snapshot) => x.scrollTop === y.scrollTop && x.first.id === y.first.id && x.first.top === y.first.top && x.size === y.size;
  const d = { pass: same(held.before, held.after) && held.back.size > held.before.size && held.back.selected === held.before.selected && held.back.detail === held.before.detail, ...held };

  // (b) Walking down a screen at a time loads every record once, in order, rendering only rows near the view.
  const oldest = (await databaseOrder()).at(-1);
  const walk = await page<{ ids: number[]; conflicts: number; gaps: number; steps: number; widest: number; longestFrameMs: number }>(`(async () => {
    const scroll = rc.scroll();
    scroll.scrollTop = 1;
    await rc.until(() => scroll.scrollTop >= 1);
    rc.longest = 0;
    const seen = new Map();
    let conflicts = 0, steps = 0, widest = 0;
    for (;;) {
      await rc.frame();
      const rows = rc.rows();
      widest = Math.max(widest, rows.length);
      for (const row of rows) { if (seen.has(row.pos) && seen.get(row.pos) !== row.id) conflicts++; seen.set(row.pos, row.id); }
      const last = rows[rows.length - 1];
      if (last.id === ${JSON.stringify(oldest)} && last.pos === last.size && !rc.reading()) break;
      if (rc.reading()) { await rc.until(() => !rc.reading()); continue; }
      scroll.scrollTop = Math.min(scroll.scrollTop + scroll.clientHeight, scroll.scrollHeight - scroll.clientHeight);
      steps++;
    }
    const positions = [...seen.keys()].sort((x, y) => x - y);
    const gaps = positions.filter((pos, index) => pos !== index + 1).length;
    return { ids: positions.map(pos => seen.get(pos)), conflicts, gaps, steps, widest, longestFrameMs: rc.longest };
  })()`);
  const order = await databaseOrder();
  const start = order.indexOf(walk.ids[0] ?? -1);
  const b = {
    pass: walk.conflicts === 0 && walk.gaps === 0 && walk.ids.length >= seed && start >= 0 && walk.ids.length === order.length - start && contiguousIn(order, walk.ids) && walk.widest < 100,
    loaded: walk.ids.length, steps: walk.steps, widestRendered: walk.widest,
  };

  // (e) The window kept answering throughout; its longest frame is reported, not judged.
  const roundTrip = Date.now();
  await page('1');
  const e = { pass: true, longestFrameMsWhileWalking: Math.round(walk.longestFrameMs), roundTripMs: Date.now() - roundTrip };
  return { pass: a.pass && b.pass && c.pass && d.pass, seed, a, b, c, d, e };
}

/**
 * Paint mask in the real, hidden workspace, on Chromium's canvas: a session editing a generated image opens the
 * mask window, which is painted, erased, cleared, undone and redone with pointer events, and each state is compared
 * pixel for pixel with the one it should restore. Returns the verdict, printed as one `MASK-CHECK {json}` line.
 */
export async function qualifyMaskCanvas(window: import('electron').BrowserWindow, service: Application, root: string) {
  const { default: sharp } = await import('sharp');
  const { listModels } = await import('picpatchsdk');
  const { join } = await import('node:path');
  const image = join(root, 'mask-source.png');
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).png().toFile(image);
  const session = await service.create('Mask check');
  const { assets: [asset] } = await service.importImages(session.id, [image]);
  const model = listModels().find(item => item.capabilities.maskMode !== undefined && item.capabilities.maskMode !== 'none');
  if (!asset || !model) throw new Error('The mask check could not prepare its session.');
  await service.draft(session.id, { ...session.draft, mode: 'edit', modelIds: [model.id], source: asset.id });
  window.webContents.send('picpatch:changed');
  const page = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script) as Promise<T>;
  await page(PAGE_HELPERS);
  return page<{ pass: boolean }>(`(async () => {
    const row = () => [...document.querySelectorAll('.session-row')].find(item => item.querySelector('.session-title')?.textContent === 'Mask check');
    await rc.until(() => row());
    row().click();
    const paint = () => document.querySelector('.composer button.icon-button.tiny[aria-pressed]');
    await rc.until(() => paint() && !paint().disabled);
    paint().click();
    const canvas = () => document.querySelector('.mask-frame canvas');
    await rc.until(() => canvas() && canvas().getBoundingClientRect().width > 0);
    await rc.frame();
    const surface = canvas(), context = surface.getContext('2d', { willReadFrequently: true });
    const width = surface.width, height = surface.height;
    const tools = document.querySelector('.mask-tools');
    const [undo, redo] = tools.querySelectorAll('.icon-button'), clear = tools.querySelector('.button.compact');
    const [paintTool, eraseTool] = tools.querySelectorAll('input[type="radio"]');
    const pixels = () => context.getImageData(0, 0, width, height).data.slice();
    const differ = (x, y) => { let count = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) count++; return count; };
    const alpha = (data, x, y) => data[(y * width + x) * 4 + 3];
    /** The painted pixels' bounds, or null when nothing is painted. */
    const painted = data => {
      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha(data, x, y)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return x1 < 0 ? null : { x0, y0, x1, y1 };
    };
    const point = (x, y) => { const box = surface.getBoundingClientRect(); return { clientX: box.left + x * box.width / width, clientY: box.top + y * box.height / height }; };
    const pointer = (type, x, y) => surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...point(x, y) }));
    const stroke = async (points) => {
      pointer('pointerdown', ...points[0]);
      for (const at of points.slice(1)) pointer('pointermove', ...at);
      pointer('pointerup', ...points.at(-1));
      await rc.frame();
    };
    const press = async button => { button.click(); await rc.frame(); };
    const radius = 24 * width / surface.getBoundingClientRect().width;
    const failures = [];
    const expect = (ok, what) => { if (!ok) failures.push(what); };
    const restores = (state, what) => expect(differ(pixels(), state) === 0, what + ' (' + differ(pixels(), state) + ' values differ)');

    const empty = pixels();
    expect(painted(empty) === null, 'the mask starts empty');
    // A stroke paints along its path and nowhere beyond its brush.
    await stroke([[60, 60], [110, 60], [160, 60]]);
    const one = pixels(), bounds = painted(one);
    expect(alpha(one, 110, 60) === 255, 'a stroke paints its path');
    expect(bounds && bounds.x0 >= Math.floor(60 - radius) - 1 && bounds.x1 <= Math.ceil(160 + radius) + 1 && bounds.y0 >= Math.floor(60 - radius) - 1 && bounds.y1 <= Math.ceil(60 + radius) + 1, 'a stroke stays within its brush: ' + JSON.stringify(bounds));
    await press(undo); restores(empty, 'undo removes the first stroke');
    await press(redo); restores(one, 'redo puts the first stroke back');
    // A second stroke elsewhere is undone by its own region alone, leaving the first as it was.
    await stroke([[300, 220], [340, 240]]);
    const two = pixels();
    expect(alpha(two, 340, 240) === 255 && alpha(two, 110, 60) === 255, 'the second stroke paints beside the first');
    await press(undo); restores(one, 'undo removes only the second stroke');
    await press(redo); restores(two, 'redo puts the second stroke back');
    // Erasing across the first stroke clears its path; undo brings back exactly what it erased.
    eraseTool.click(); await rc.frame();
    await stroke([[110, 10], [110, 60], [110, 110]]);
    const erased = pixels();
    expect(alpha(erased, 110, 60) === 0 && alpha(erased, 65, 60) === 255 && alpha(erased, 340, 240) === 255, 'erasing clears only its path');
    await press(undo); restores(two, 'undo restores what the eraser cleared');
    await press(redo); restores(erased, 'redo erases again');
    paintTool.click(); await rc.frame();
    // Clear empties the mask; undo and redo move across it whole, and the strokes before it undo in turn.
    await press(clear);
    restores(empty, 'Clear empties the mask');
    await press(undo); restores(erased, 'undo restores the mask Clear emptied');
    await press(redo); restores(empty, 'redo clears again');
    await press(undo); restores(erased, 'undo restores it again');
    await press(undo); restores(two, 'then the erase undoes');
    await press(undo); restores(one, 'then the second stroke');
    await press(undo); restores(empty, 'then the first');
    expect(undo.disabled && !redo.disabled, 'undo ends at the first stroke and redo is offered');
    return { pass: failures.length === 0, failures, image: { width, height }, brushRadius: radius };
  })()`);
}
