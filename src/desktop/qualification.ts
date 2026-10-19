import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import type { Application } from '../app/service.ts';
/** Explicit automated package qualification; never reached during ordinary launch. */
export async function qualifyInference(service: Application, configuration: string, uv: string): Promise<void> {
  if (!isAbsolute(configuration)) throw new Error('Qualification configuration must be absolute.');
  const config = JSON.parse(await readFile(configuration, 'utf8'));
  const version = await promisify(execFile)(uv, ['--version'], { timeout: 5000 });
  if (!version.stdout.startsWith('uv 0.13.1 ')) throw new Error('Unexpected bundled setup tool.');
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
export async function qualifyLocalization(window: import('electron').BrowserWindow, root: string): Promise<void> {
  const { languages } = await import('../shared/i18n/index.ts');
  for (const [language] of languages) {
    await window.webContents.executeJavaScript(`(async () => {
      await window.picpatch.call('preferences', { language: ${JSON.stringify(language)}, engineDirectory: ${JSON.stringify(root + '/engine')}, modelsDirectory: ${JSON.stringify(root + '/models')} });
      const deadline = Date.now() + 5000;
      while (document.documentElement.lang !== ${JSON.stringify(language)}) { if (Date.now() > deadline) throw new Error('Language did not update.'); await new Promise(resolve => setTimeout(resolve, 20)); }
    })()`);
    for (const theme of ['light', 'dark'] as const) for (const [width, height] of [[1280, 850], [1024, 700]]) {
      const { nativeTheme } = await import('electron'); nativeTheme.themeSource = theme;
      window.setContentSize(width!, height!);
      await window.webContents.executeJavaScript(`(async () => {
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await settle();
        if (innerWidth !== ${width} || innerHeight !== ${height}) throw new Error('Unexpected qualification viewport: ' + innerWidth + 'x' + innerHeight);
        if (matchMedia('(prefers-color-scheme: dark)').matches !== ${theme === 'dark'}) throw new Error('Qualification theme did not apply.');
        document.querySelector('#setup[open] #skipSetup')?.click();
        for (const id of ['settings', 'management', 'shortcuts', 'setup', 'appMessage']) {
          const dialog = document.getElementById(id);
          const trigger = document.getElementById({ settings: 'settingsButton', management: 'manage', shortcuts: 'shortcutsButton', setup: 'fixModels', appMessage: 'sessionsToggle' }[id]);
          const menuAction = ['settings','management','shortcuts'].includes(id);
          if (menuAction) document.getElementById('menuButton').click();
          trigger.focus();
          const pending = id === 'appMessage' ? window.picpatch.call('delete', { id: 'qualification-cancel-only' }) : undefined;
          if (!pending) trigger.click();
          const deadline = Date.now() + 5000;
          while (!dialog.open || (id === 'management' && !document.getElementById('manageModel').options.length)) { if (Date.now() > deadline) throw new Error('Dialog did not populate: ' + id); await new Promise(resolve => setTimeout(resolve, 20)); }
          if (id === 'management') {
            const models = document.getElementById('manageModel');
            const native = [...models.options].find(option => option.value.includes('sdxl'));
            if (native) { models.value = native.value; models.dispatchEvent(new Event('change')); }
          }
          if (id === 'settings') { document.getElementById('resourcesTab').click(); await settle(); document.getElementById('generalTab').click(); }
          for (const details of dialog.querySelectorAll('details')) details.open = true;
          await settle();
          const failures = [];
          if (dialog.getBoundingClientRect().height < 1) failures.push(id + ': not rendered');
          const body = dialog.querySelector('.modalBody'), header = dialog.querySelector('.modalHeader'), footer = dialog.querySelector('.modalFooter');
          const bands = [header, body, footer].map(element => element.getBoundingClientRect());
          if (bands[0].bottom > bands[1].top + 2 || bands[1].bottom > bands[2].top + 2 || bands[2].bottom > innerHeight + 1) failures.push(id + ': unreachable bands');
          body.scrollTop = body.scrollHeight; await settle();
          if (footer.getBoundingClientRect().bottom > innerHeight + 1) failures.push(id + ': footer left viewport');
          if (dialog.scrollWidth > dialog.clientWidth + 2) failures.push(id + ': horizontal overflow');
          for (const control of dialog.querySelectorAll('button')) if (control.getClientRects().length && control.scrollWidth > control.clientWidth + 2) failures.push(control.id + ': clipped caption');
          if (!dialog.contains(document.activeElement)) failures.push(id + ': focus outside modal');
          document.getElementById({ settings: 'cancelSettings', management: 'closeManagement', shortcuts: 'closeShortcuts', setup: 'skipSetup', appMessage: 'messageCancel' }[id]).click();
          await settle();
          if (dialog.open || document.activeElement !== (menuAction ? document.getElementById('menuButton') : trigger)) failures.push(id + ': close/focus return failed');
          if (pending && await pending !== false) throw new Error('Qualification must cancel deletion.');
          if (failures.length) throw new Error(${JSON.stringify(language + ':' + theme + ':' + width + 'x' + height)} + ': ' + failures.join('; '));
        }
        for (const element of document.querySelectorAll('[data-i18n]')) if (!element.textContent.trim()) throw new Error('Empty translation: ' + element.dataset.i18n);
        if (document.querySelector('header').scrollWidth > document.querySelector('header').clientWidth + 2) throw new Error('Header overflow');
      })()`);
    }
  }
}

/** Geometry is measured in the real hidden renderer; records remain literal. */
export async function qualifyLogs(window: import('electron').BrowserWindow, workspace: import('electron').BrowserWindow): Promise<void> {
  const { languages } = await import('../shared/i18n/index.ts');
  for (const [language] of languages) for (const theme of ['light', 'dark']) {
    await workspace.webContents.executeJavaScript(`window.picpatch.call('preferences', {language: ${JSON.stringify(language)}, theme: ${JSON.stringify(theme)}})`);
    for (const [width, height] of [[760, 480], [1100, 720]]) {
      window.setContentSize(width!, height!);
      await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000;
        while (document.body.hidden || document.documentElement.lang !== ${JSON.stringify(language)} || document.documentElement.style.colorScheme !== ${JSON.stringify(theme)}) {
          if (Date.now() > deadline) throw new Error('Logs appearance did not settle.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const list = document.getElementById('logsList');
        const detail = document.getElementById('logsDetail');
        const footer = document.querySelector('footer');
        const content = document.getElementById('logsContent');
        const header = document.getElementById('logsFilters');
        for (const issueShown of [false, true]) {
          const issue = document.getElementById('logsIssue'); issue.hidden = !issueShown;
          if (issueShown) issue.textContent = document.getElementById('logsStatus').textContent || 'Read failed';
          await new Promise(resolve => requestAnimationFrame(resolve));
          const bands = [header, content, footer].map(item => item.getBoundingClientRect());
          if (bands[0].bottom > bands[1].top + 1 || bands[1].bottom > bands[2].top + 1 || bands[2].bottom > innerHeight + 1 || list.clientHeight < 100 || detail.clientHeight < 100) throw new Error('Logs regions do not fit.');
          for (const control of document.querySelectorAll('button,select,input')) if (control.scrollWidth > control.clientWidth + 2) throw new Error('Logs control clips: ' + control.id);
          if (document.getElementById('logsFrame').scrollWidth > innerWidth + 1) throw new Error('Logs frame overflows.');
        }
        document.getElementById('logsIssue').hidden = true;
      })()`);
    }
  }
}
