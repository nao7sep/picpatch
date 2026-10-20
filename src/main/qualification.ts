import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
          for (const tab of dialog.querySelectorAll('[role="tab"]')) { tab.focus(); tab.click(); await settle(); }
          await settle();
          const failures = [];
          const bands = ['.modal-head', '.modal-body', '.modal-foot'].map(selector => dialog.querySelector(selector)?.getBoundingClientRect()).filter(Boolean);
          for (let i = 1; i < bands.length; i++) if (bands[i - 1].bottom > bands[i].top + 2) failures.push('bands overlap');
          if (bands.at(-1).bottom > innerHeight + 1) failures.push('footer left viewport');
          if (dialog.scrollWidth > dialog.clientWidth + 2) failures.push('horizontal overflow');
          failures.push(...clipped(dialog).map(text => 'clipped ' + text));
          if (!dialog.contains(document.activeElement)) failures.push('focus outside modal');
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
