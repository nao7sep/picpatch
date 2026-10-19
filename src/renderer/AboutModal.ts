import { about } from '../shared/about.ts';
import { errorText, t } from '../shared/i18n/index.ts';
import { modal } from './Modal.ts';
import type { Bridge } from '../shared/bridge.ts';
export function aboutModal(api: Bridge) {
  const surface = document.getElementById('about') as HTMLDialogElement;
  const shell = modal(surface, document.getElementById('closeAbout') as HTMLButtonElement);
  document.getElementById('aboutIdentity')!.textContent = `${about.name} ${about.version}`;
  document.getElementById('aboutLicense')!.textContent = about.license;
  document.getElementById('aboutCopyright')!.textContent = about.copyright;
  for (const destination of ['repository','issues'] as const) {
    const link = document.createElement('a'); link.href = about[destination]; link.dataset.i18n = `about.${destination}`; link.textContent = t(`about.${destination}`);
    link.onclick = event => { event.preventDefault(); void api.call('openProjectLink', { destination }).catch(error => { document.getElementById('aboutIssue')!.textContent = errorText(error); }); };
    const row = document.createElement('p'); row.append(link); document.getElementById('aboutLinks')!.append(row);
  }
  return shell;
}
