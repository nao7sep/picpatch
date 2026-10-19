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
    for (const width of [1280, 1024]) {
      window.setContentSize(width, 900);
      await window.webContents.executeJavaScript(`(async () => {
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await settle();
        for (const id of ['settings', 'management', 'records']) {
          const dialog = document.getElementById(id);
          document.getElementById({ settings: 'settingsButton', management: 'manage', records: 'showRecords' }[id]).click();
          const deadline = Date.now() + 5000;
          while (!dialog.open || (id === 'management' && !document.getElementById('manageModel').options.length)) { if (Date.now() > deadline) throw new Error('Dialog did not populate: ' + id); await new Promise(resolve => setTimeout(resolve, 20)); }
          if (id === 'management') {
            const models = document.getElementById('manageModel');
            const native = [...models.options].find(option => option.value.includes('sdxl'));
            if (native) { models.value = native.value; models.dispatchEvent(new Event('change')); }
          }
          for (const details of dialog.querySelectorAll('details')) details.open = true;
          await settle();
          const failures = [];
          if (dialog.scrollWidth > dialog.clientWidth + 2) failures.push(id + ': horizontal overflow');
          for (const control of dialog.querySelectorAll('button')) if (control.getClientRects().length && control.scrollWidth > control.clientWidth + 2) failures.push(control.id + ': clipped caption');
          dialog.close(); if (failures.length) throw new Error(failures.join('; '));
        }
        for (const element of document.querySelectorAll('[data-i18n]')) if (!element.textContent.trim()) throw new Error('Empty translation: ' + element.dataset.i18n);
        if (document.querySelector('header').scrollWidth > document.querySelector('header').clientWidth + 2) throw new Error('Header overflow');
      })()`);
    }
  }
}
