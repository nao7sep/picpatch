import { aboutModal } from './AboutModal.ts';
import { operationResults } from './operation-results.ts';
import { defaultFont, fixedFont } from '../shared/appearance.ts';
import { commandShortcuts } from './shortcuts.ts';
import { shortcutsModal } from './ShortcutsModal.ts';
import { toolbar } from './toolbar.ts';
import { messageModal } from './MessageModal.ts';
import { closeTopModal } from './Modal.ts';
import { isComposing } from './ime.ts';
import { localize } from './localization.ts';
import { t, term, number, errorText, UiError, activeLocale } from '../shared/i18n/index.ts';
import { renderCollection } from './collection.ts';
import { paneLayout } from './layout.ts';
import { fitScale, imagePoint, wipeCompatible } from '../shared/viewport.ts';
import { managementModal } from './ManagementModal.ts';
import { settingsModal } from './SettingsModal.ts';
import { recordsModal } from './RecordsModal.ts';
import { sourceDrop } from './source-drop.ts';
import { incompatibilities } from '../shared/admission.ts';
import type { Bridge } from '../shared/bridge.ts';
import type { Session, Draft, Asset, Run } from '../app/types.ts';
import type { ModelCapabilities } from 'picpatchsdk/types';
declare global { interface Window { picpatch: Bridge } }
const api = window.picpatch;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const input = (id: string) => element<HTMLInputElement>(id);
let session: Session | undefined;
let overview: any;
let selected: string[] = [];
let parent: string | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saves = Promise.resolve();
let renamePending = false;
let commands = Promise.resolve();
function command(work: () => unknown, key?: string) {
  const owner = key && !['new','delete','collection','save','saveSettings','cancel'].includes(key) ? requestIssues : shellIssues;
  const identity = key ? `${session?.id ?? ''}:${key}` : undefined;
  const name = session?.name; const labelKey = key ? document.getElementById(key)?.dataset.i18n : undefined;
  const label = labelKey ? () => name ? t('common.status', { name, status: t(labelKey) }) : t(labelKey) : undefined;
  const next = commands.then(work).then(() => { if (identity) owner.clear(identity); });
  commands = next.catch(error => identity ? owner.show(identity, error, label) : issue(error)); return next;
}
let painting = false, drawing = false;
const undo: ImageData[] = [], redo: ImageData[] = [];
const mask = element<HTMLCanvasElement>('mask'); const context = mask.getContext('2d')!;
const image = element<HTMLImageElement>('image'); image.crossOrigin = 'anonymous';
let maskDirty = false, maskRevision = 0;
let maskSave = Promise.resolve();
let fitting = true;
const comparison = element<HTMLImageElement>('comparison');
let lastStroke: { x: number; y: number } | undefined;
const shellIssues = operationResults(element('issue'));
const requestIssues = operationResults(element('requestIssues'));
function issue(error: unknown) { shellIssues.show(errorText(error), error); }
function action(id: string, work: () => unknown) { element(id).addEventListener('click', () => { void command(work, id).catch(() => {}); }); }
const imageUrl = (id: string) => `picpatch-image://${session!.id}/${id}`;
function button(text: string, work: () => unknown) { const b = document.createElement('button'); b.textContent = text; b.onclick = () => { void command(work, text).catch(() => {}); }; return b; }
function collect(): Draft {
  const d = session!.draft;
  d.mode = input('mode').value as Draft['mode']; d.text = input('text').value;
  d.modelIds = [...element('modelList').querySelectorAll<HTMLInputElement>('input:checked')].map(item => item.value);
  d.width = Number(input('width').value); d.height = Number(input('height').value);
  if (input('seed').value === '') delete d.seed; else d.seed = Number(input('seed').value);
  for (const field of element('parameters').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select,textarea')) {
    const key = field.dataset.key!;
    if (field.value === '') delete (d.parameters as any)[key]; else (d.parameters as any)[key] = field.dataset.numeric ? Number(field.value) : field.value;
  }
  if (input('expand').checked) d.outpaint = { width: Number(input('outWidth').value), height: Number(input('outHeight').value), left: Number(input('outLeft').value), top: Number(input('outTop').value) }; else delete d.outpaint;
  if (d.control) { if (input('controlStrength').value === '') delete d.control.strength; else d.control.strength = Number(input('controlStrength').value); }
  return d;
}
function scheduleSave() { if (!session) return; session.draft = collect(); admission(); clearTimeout(saveTimer); saveTimer = setTimeout(() => { void flush().catch(error => requestIssues.show('draft', error)); }, 350); }
async function flush() {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (!session) return;
  const id = session.id, draft = structuredClone(session.draft), name = session.name, rename = renamePending;
  const next = saves.then(async () => { await api.call('draft', { id, draft }); if (rename) { await api.call('rename', { id, name }); if (session?.id === id && session.name === name) renamePending = false; } });
  saves = next.catch(() => {}); await next; requestIssues.clear('draft');
}
function fields() {
  const d = session!.draft;
  input('mode').value = d.mode; input('text').value = d.text; input('width').value = String(d.width); input('height').value = String(d.height); input('seed').value = d.seed === undefined ? '' : String(d.seed);
  input('sessionName').value = session!.name;
  input('expand').checked = Boolean(d.outpaint);
  if (d.outpaint) { input('outWidth').value = String(d.outpaint.width); input('outHeight').value = String(d.outpaint.height); input('outLeft').value = String(d.outpaint.left); input('outTop').value = String(d.outpaint.top); }
  const models = element('modelList'); models.replaceChildren();
  for (const model of overview.models) { const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = model.id; checkbox.checked = d.modelIds.includes(model.id); label.append(checkbox, document.createTextNode(` ${model.id}`)); checkbox.onchange = () => { scheduleSave(); capabilities(); }; models.append(label); }
  capabilities(); references();
}
function admission() {
  if (!session) return;
  const messages = session.draft.modelIds.flatMap(id => { const model = overview.models.find((m: any) => m.id === id); return model ? incompatibilities(session!.draft, model.capabilities).map(message => t('admission.reason', { model: id, reason: message })) : [t('admission.unavailable', { model: id })]; });
  element('admission').textContent = messages.reduce((first, rest) => t('common.lines', { first, rest }), '');
  input('run').disabled = !session.draft.modelIds.length || messages.length > 0;
}
function capabilities() {
  const d = session!.draft; const model = overview.models.find((m: any) => m.id === d.modelIds[0]); const caps: ModelCapabilities | undefined = model?.capabilities;
  element('editControls').hidden = d.mode !== 'edit'; element('run').textContent = d.mode === 'edit' ? t('ui.edit') : t('ui.generate');
  element('maskSemantics').textContent = caps?.maskMode === 'composite' || caps?.maskMode === 'latent-composite' ? t('ui.masked_edits_preserve_normalized_pixels_outside_the_edited_region') : caps?.maskMode === 'native' ? t('ui.native_inpainting_pixels_outside_the_mask_may_change') : t('ui.this_model_does_not_support_masks');
  input('paint').disabled = !d.source || !caps || caps.maskMode === 'none'; input('expand').disabled = !caps?.outpainting;
  admission();
  input('addControl').disabled = !caps?.controlKinds?.includes('canny');
  element('controlName').textContent = d.control ? session!.assets.find(a => a.id === d.control!.image)?.name ?? t('ui.control_image') : t('ui.no_canny_map');
  input('controlStrength').value = d.control?.strength === undefined ? '' : String(d.control.strength);
  const parameters = element('parameters'); parameters.replaceChildren();
  for (const key of ['steps', 'guidance', 'strength', 'identityStyleStrength', 'appearanceStrength', 'sampler', 'scheduler', 'negativePrompt']) {
    const descriptor = (caps?.parameters as any)?.[key]; const existing = (d.parameters as any)[key];
    if (!descriptor && existing === undefined) continue;
    const label = document.createElement('label'); label.append(document.createTextNode(descriptor ? term('parameter', key) : t('parameter.unsupported', { name: term('parameter', key) })));
    let field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (descriptor?.values) { field = document.createElement('select'); const blank = document.createElement('option'); blank.value = ''; blank.textContent = t('parameter.default', { value: typeof descriptor.default === 'number' ? descriptor.default : String(descriptor.default) }); field.append(blank); for (const value of descriptor.values) { const opt = document.createElement('option'); opt.value = value; opt.textContent = value; field.append(opt); } }
    else if (key === 'negativePrompt') field = document.createElement('textarea');
    else { field = document.createElement('input'); field.type = 'number'; field.step = descriptor?.integer ? '1' : 'any'; field.dataset.numeric = 'true'; field.placeholder = descriptor?.default === undefined ? t('ui.default') : typeof descriptor.default === 'number' ? number(descriptor.default) : String(descriptor.default); }
    field.dataset.key = key; field.value = existing === undefined ? '' : String(existing); field.oninput = scheduleSave; label.append(field); parameters.append(label);
  }
}
function references() {
  const holder = element('references'); holder.replaceChildren();
  for (const [index, group] of session!.draft.references.entries()) {
    const box = document.createElement('div'); box.className = 'reference';
    const name = document.createElement('input'); name.value = group.id; name.setAttribute('aria-label', t('ui.reference_group_name')); name.onchange = () => { group.id = name.value; void flush().catch(error => requestIssues.show('draft', error)); }; box.append(name);
    const role = document.createElement('select'); for (const value of ['subject','object','style','background']) { const option = document.createElement('option'); option.value = value; option.textContent = term('role', value); role.append(option); } role.setAttribute('aria-label', t('ui.reference_role')); role.value = group.role; role.onchange = () => { group.role = role.value as typeof group.role; admission(); void flush().catch(error => requestIssues.show('draft', error)); }; box.append(role);
    for (const [key, values] of [['conditioning', ['prompt','identity','appearance']], ['className', ['', 'man','woman','girl','boy']]] as const) {
      const label = document.createElement('label'); label.textContent = key === 'conditioning' ? t('ui.conditioning') : t('ui.identity_class');
      const select = document.createElement('select');
      for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = value ? term(key === 'conditioning' ? 'conditioning' : 'class', value) : t('ui.not_selected'); select.append(option); }
      select.value = group[key] ?? (key === 'conditioning' ? 'prompt' : '');
      select.onchange = () => { if (key === 'conditioning') group.conditioning = select.value as typeof group.conditioning; else if (select.value) group.className = select.value as typeof group.className; else delete group.className; admission(); void flush().catch(error => requestIssues.show('draft', error)); };
      label.append(select); box.append(label);
    }
    for (const id of group.images) { const img = document.createElement('img'); img.src = imageUrl(id); img.alt = t('ui.reference'); box.append(img, button(t('ui.remove_photo'), async () => { group.images = group.images.filter(value => value !== id); await flush(); references(); admission(); })); }
    box.append(button(t('ui.add_photos'), async () => { const added: Asset[] = await api.call('import', { id: session!.id }); group.images.push(...added.map(asset => asset.id)); await refresh(); await flush(); references(); admission(); }), button(t('ui.remove_group'), async () => { session!.draft.references.splice(index, 1); await flush(); references(); })); holder.append(box);
  }
  element('sourceName').textContent = session!.draft.source ? session!.assets.find(a => a.id === session!.draft.source)?.name ?? t('ui.selected_result') : t('ui.no_source_image');
}
function results() {
  const holder = element('results'); const items = [];
  for (const run of session!.runs) {
    const b = document.createElement('button'); b.className = `result${selected.includes(run.id) ? ' selected' : ''}`;
    if (run.output) { const img = document.createElement('img'); img.src = imageUrl(run.id); img.alt = ''; b.append(img); }
    const text = document.createElement('div'); text.textContent = t('run.card', { model: run.modelId, seed: run.seed, status: term('status', run.status) }); b.append(text);
    items.push({ key: run.id, label: t('run.card', { model: run.modelId, seed: run.seed, status: term('status', run.status) }), element: b });
  }
  renderCollection(holder, items, { label: t('ui.results'), empty: t('ui.generated_images_and_queued_attempts_appear_here'), selected, multiple: true, horizontal: true, select: keys => { void command(async () => { await saveMask(); await flush(); selected = keys; results(); show(); }).catch(() => {}); } });
}
function comparisonVisible(visible: boolean) { comparison.hidden = !visible; element('compare').setAttribute('aria-pressed', String(visible)); }
function show() {
  if (selected.length !== 2) { comparisonVisible(false); element('imageStage').classList.remove('wipe'); input('wipePosition').hidden = true; }
  const run = session!.runs.find(r => r.id === selected[selected.length - 1]);
  const asset = run?.output ? run.id : session!.draft.source;
  element('empty').hidden = Boolean(asset); element('imageStage').hidden = !asset;
  if (asset && image.dataset.asset !== asset) { image.dataset.asset = asset; image.src = imageUrl(asset); maskDirty = false; undo.length = 0; redo.length = 0; }
  element('resultInfo').textContent = run ? [t('run.summary', { status: term('status', run.status), model: run.modelId, seed: run.seed }), ...(run.issue ? [errorText(run.issue)] : []), ...(run.notices ?? []).map(errorText)].reduce((first, rest) => t('common.lines', { first, rest })) : '';
  input('cancelSelected').disabled = !session!.runs.some(run => selected.includes(run.id) && ['queued', 'running'].includes(run.status));
  input('reuse').disabled = !run; input('editResult').disabled = !run?.output; input('save').disabled = !run?.output; input('saveSettings').disabled = !run?.output;
}
function scale(fit = fitting) {
  if (!image.naturalWidth) return;
  fitting = fit;
  const viewport = element('canvas');
  const first = { width: image.naturalWidth, height: image.naturalHeight };
  const second = { width: comparison.naturalWidth, height: comparison.naturalHeight };
  const comparing = !comparison.hidden && second.width > 0;
  const wipe = comparing && input('compareMode').value === 'wipe' && wipeCompatible(first, second);
  if (comparing && input('compareMode').value === 'wipe' && !wipe) input('compareMode').value = 'side';
  const ratio = fit ? fitScale({ width: viewport.clientWidth, height: viewport.clientHeight }, first, comparing && !wipe ? second : undefined) : Number(input('zoom').value) / 100;
  input('zoom').value = String(Math.round(ratio * 100));
  image.width = Math.max(1, Math.round(first.width * ratio)); image.height = Math.max(1, Math.round(first.height * ratio));
  const stage = element('imageStage'); stage.style.width = `${image.width}px`; stage.style.height = `${image.height}px`;
  stage.classList.toggle('wipe', wipe); input('wipePosition').hidden = !wipe;
  if (comparing) {
    comparison.width = Math.round(second.width * ratio); comparison.height = Math.round(second.height * ratio);
    (wipe ? stage : viewport).append(comparison);
    comparison.style.clipPath = wipe ? `inset(0 0 0 ${input('wipePosition').value}%)` : '';
  }
}
comparison.onload = () => scale();
input('compareMode').onchange = () => scale(); input('wipePosition').oninput = () => scale(false);
new ResizeObserver(() => { if (fitting) scale(true); }).observe(element('canvas'));
image.onload = () => {
  mask.width = image.naturalWidth; mask.height = image.naturalHeight; scale();
  const owner = session;
  if (owner && image.dataset.asset === owner.draft.source && owner.draft.mask) {
    const saved = new Image(); saved.crossOrigin = 'anonymous'; const sourceId = image.dataset.asset;
    saved.onload = () => { if (image.dataset.asset !== sourceId || drawing || maskDirty) return; context.drawImage(saved, 0, 0); const pixels = context.getImageData(0,0,mask.width,mask.height); for (let i=0;i<pixels.data.length;i+=4) { pixels.data[i+3]=pixels.data[i]!; pixels.data[i]=255; pixels.data[i+1]=255; pixels.data[i+2]=255; } context.putImageData(pixels,0,0); };
    saved.src = imageUrl(owner.draft.mask);
  }
};
function point(event: PointerEvent) { return imagePoint({ x: event.clientX, y: event.clientY }, mask.getBoundingClientRect(), { width: mask.width, height: mask.height }); }
function stroke(event: PointerEvent) {
  const p = point(event); context.globalCompositeOperation = input('erase').checked ? 'destination-out' : 'source-over';
  context.strokeStyle = '#ffffff'; context.lineWidth = Number(input('brush').value); context.lineCap = 'round';
  context.beginPath(); context.moveTo(lastStroke?.x ?? p.x, lastStroke?.y ?? p.y); context.lineTo(p.x, p.y); context.stroke();
  context.fillStyle = '#ffffff'; context.beginPath(); context.arc(p.x, p.y, context.lineWidth / 2, 0, Math.PI * 2); context.fill();
  lastStroke = p; maskDirty = true; maskRevision++;
}
mask.onpointerdown = event => { if (!painting || event.altKey) return; undo.push(context.getImageData(0,0,mask.width,mask.height)); while (undo.length > 1 && undo.length * mask.width * mask.height * 4 > 64 * 1024 * 1024) undo.shift(); redo.length = 0; drawing = true; lastStroke = undefined; mask.setPointerCapture(event.pointerId); stroke(event); };
mask.onpointermove = event => { if (drawing) stroke(event); };
mask.onpointerup = () => { drawing = false; void saveMask().then(flush).catch(error => requestIssues.show('mask', error)); };
mask.onpointercancel = () => { drawing = false; void saveMask().then(flush).catch(error => requestIssues.show('mask', error)); };
function saveMask(): Promise<void> { const next = maskSave.then(persistMask).then(() => requestIssues.clear('mask')); maskSave = next.catch(() => {}); return next; }
async function persistMask() {
  if (!maskDirty) return;
  const owner = session!, revision = maskRevision;
  const output = document.createElement('canvas'); output.width = mask.width; output.height = mask.height;
  const ctx = output.getContext('2d')!; ctx.fillStyle = 'black'; ctx.fillRect(0,0,output.width,output.height); ctx.drawImage(mask,0,0);
  const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new UiError('ui.could_not_encode_mask')), 'image/png'));
  const asset: Asset = await api.call('mask', { id: owner.id, bytes: new Uint8Array(await blob.arrayBuffer()) });
  owner.draft.mask = asset.id; maskDirty = revision !== maskRevision;
}
async function refresh() {
  overview = await api.call('overview');
  document.documentElement.style.setProperty('--font-ui', overview.settings.uiFont || defaultFont);
  document.documentElement.style.setProperty('--font-mono', fixedFont);
  const languageChanged = await localize(overview.locale ?? { language: 'en', format: 'en' });
  settings.systemTheme(overview.systemDark);
  if (languageChanged && session) { fields(); element('paint').textContent = painting ? t('ui.finish_painting') : t('ui.paint_mask'); shellIssues.localize(); requestIssues.localize(); }
  const holder = element('sessionList');
  renderCollection(holder, overview.sessions.map((item: any) => ({ key: item.id, label: item.name, element: button(item.name, () => {}) })), { label: t('ui.sessions'), empty: t('ui.no_saved_sessions'), selected: session ? [session.id] : [], select: keys => { if (keys[0]) void command(() => open(keys[0]!)).catch(() => {}); } });
  for (const failure of overview.failures) { const p = document.createElement('p'); p.textContent = errorText(failure.message); holder.append(p); }
  if (session) { const owner = session; const fresh: Session = await api.call('get', { id: owner.id }); if (session === owner) { owner.runs = fresh.runs; owner.assets = fresh.assets; results(); show(); } }
  if (overview.historyIssue) shellIssues.show('history', overview.historyIssue); else shellIssues.clear('history');
  const active = overview.queue.active;
  element('status').textContent = overview.queue.paused ? t('run.paused', { reason: overview.queue.issue ? errorText(overview.queue.issue) : t('ui.resume_when_ready') }) : active ? t('run.elapsed', { stage: term('stage', active.stage), count: Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000)) }) : t('ui.ready');
  element('cancel').hidden = !active;
  const progress = element<HTMLProgressElement>('progress'); progress.hidden = !active?.progress;
  if (active?.progress) { progress.max = active.progress.total; progress.value = active.progress.completed; }
}
async function open(id: string) {
  element('request').inert = true; input('sessionName').disabled = true;
  try {
  if (session) { await saveMask(); await flush(); }
  session = await api.call('get', { id }); renamePending = false; selected = session!.runs.filter(r => r.output).slice(-1).map(r => r.id); parent = undefined;
  fields(); results(); show();
  } finally { element('request').inert = false; input('sessionName').disabled = false; }
}
action('new', async () => { await saveMask(); await flush(); const created: Session = await api.call('create'); await refresh(); await open(created.id); });

action('import', async () => { const assets: Asset[] = await api.call('import', { id: session!.id }); if (assets[0]) { session!.draft.source = assets[0].id; delete session!.draft.mask; session!.draft.mode = 'edit'; selected = []; await refresh(); fields(); await flush(); show(); } });
action('clearSource', async () => { delete session!.draft.source; delete session!.draft.mask; maskDirty = false; selected = []; fields(); await flush(); show(); });
action('addReference', async () => { const assets: Asset[] = await api.call('import', { id: session!.id }); if (!assets.length) return; session!.draft.references.push({ id: t('reference.name', { number: session!.draft.references.length + 1 }), role: 'subject', images: assets.map(a => a.id) }); await refresh(); references(); admission(); await flush(); });
action('addControl', async () => { const assets: Asset[] = await api.call('import', { id: session!.id }); if (assets[0]) { session!.draft.control = { image: assets[0].id, kind: 'canny' }; await refresh(); capabilities(); await flush(); } });
action('clearControl', async () => { delete session!.draft.control; capabilities(); await flush(); });
input('controlStrength').oninput = scheduleSave;
action('run', async () => { session!.draft = collect(); await saveMask(); await flush(); await api.call('submit', { id: session!.id, draft: session!.draft, samples: Number(input('samples').value), parent }); await refresh(); });
action('resume', async () => { await api.call('resume', { id: session!.id }); await refresh(); });
action('cancelSelected', async () => { const owner = session!; for (const run of owner.runs.filter(run => selected.includes(run.id) && ['queued', 'running'].includes(run.status))) await api.call('cancel', { id: owner.id, runId: run.id }); await refresh(); });
action('cancel', async () => { const active = overview.queue.active; if (active) await api.call('cancel', { id: active.sessionId, runId: active.runId }); });
action('reuse', async () => { await saveMask(); const run = session!.runs.find(r => r.id === selected.at(-1)); if (!run) return; session!.draft = structuredClone(run.draft); session!.draft.seed = run.seed; session!.draft.modelIds = [run.modelId]; fields(); await flush(); });
action('editResult', async () => { const run = session!.runs.find(r => r.id === selected.at(-1)); if (!run?.output) return; await saveMask(); session!.draft.mode = 'edit'; session!.draft.source = run.id; delete session!.draft.mask; parent = run.id; fields(); await flush(); show(); });
action('fit', () => scale(true)); action('actual', () => { input('zoom').value = '100'; scale(false); }); input('zoom').oninput = () => scale(false);
action('paint', () => { selected = []; show(); painting = !painting; mask.classList.toggle('painting', painting); element('paint').textContent = painting ? t('ui.finish_painting') : t('ui.paint_mask'); });
action('clearMask', async () => { context.clearRect(0,0,mask.width,mask.height); delete session!.draft.mask; maskDirty = false; await flush(); });
action('undoMask', () => { const previous = undo.pop(); if (previous) { redo.push(context.getImageData(0,0,mask.width,mask.height)); context.putImageData(previous,0,0); maskDirty = true; maskRevision++; return saveMask().then(flush); } });
action('redoMask', () => { const next = redo.pop(); if (next) { undo.push(context.getImageData(0,0,mask.width,mask.height)); context.putImageData(next,0,0); maskDirty = true; maskRevision++; return saveMask().then(flush); } });
action('compare', async () => { const second = element<HTMLImageElement>('comparison'); if (!second.hidden) { comparisonVisible(false); scale(true); return; } if (selected.length !== 2) throw new UiError('ui.commandclick_two_completed_results_to_compare'); const run = session!.runs.find(r => r.id === selected[0]); if (!run?.output) throw new UiError('ui.choose_completed_results'); await saveMask(); painting = false; mask.classList.remove('painting'); second.src = imageUrl(run.id); comparisonVisible(true); });
for (const [id, sidecar] of [['save',false], ['saveSettings',true]] as const) action(id, async () => { await flush(); const result = await api.call('export', { id: session!.id, runId: selected.at(-1), sidecar, includeInputs: input('includePrompts').checked }); if (result?.status === 'refused') throw Object.assign(new Error(result.message), { code: result.code, effect: result.effect }); if (result?.sidecar?.status === 'failed') throw new UiError('ui.image_saved_its_settings_sidecar_could_not_be_saved'); if (result?.status === 'saved') element('status').textContent = sidecar ? t('ui.image_and_settings_saved') : t('ui.image_saved'); });
action('delete', async () => { const id = session!.id; if (await api.call('delete', { id })) { session = undefined; await start(); } });
action('collection', async () => { await saveMask(); await flush(); if (await api.call('collection')) { session = undefined; await start(); } });
input('sessionName').oninput = () => { session!.name = input('sessionName').value; renamePending = true; clearTimeout(saveTimer); saveTimer = setTimeout(() => { void flush().then(refresh).catch(issue); }, 350); };
for (const id of ['mode','text','width','height','seed','expand','outWidth','outHeight','outLeft','outTop']) input(id).addEventListener('input', () => { scheduleSave(); if (id === 'mode') capabilities(); });
let closing = false;
let closeFocus: HTMLElement | undefined;
let flushing: Promise<void> | undefined;
const messages = messageModal();
const about = aboutModal(api);
shortcutsModal(); toolbar(element('canvasActions'));
managementModal(api, refresh); const settings = settingsModal(api, refresh, messages); recordsModal(api);
let pan: { x: number; y: number; left: number; top: number } | undefined;
const viewport = element('canvas');
viewport.addEventListener('pointerdown', event => { if (!event.altKey || drawing) return; pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture(event.pointerId); event.preventDefault(); });
viewport.addEventListener('pointermove', event => { if (pan) { viewport.scrollLeft = pan.left - event.clientX + pan.x; viewport.scrollTop = pan.top - event.clientY + pan.y; } });
viewport.addEventListener('pointerup', () => { pan = undefined; }); viewport.addEventListener('pointercancel', () => { pan = undefined; });
sourceDrop(viewport, file => command(async () => { await saveMask(); await flush(); const added: Asset[] = await api.call('import', { id: session!.id, path: api.droppedFile(file) }); session!.draft.source = added[0]!.id; delete session!.draft.mask; session!.draft.mode = 'edit'; selected = []; await refresh(); fields(); await flush(); show(); }, 'import').catch(() => {}), error => requestIssues.show(`${session?.id ?? ''}:import`, error));
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
api.onChange(() => { if (!loaded) return; if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().then(() => shellIssues.clear('refresh')).catch(error => shellIssues.show('refresh', error)); }, 100); });
async function start() { await refresh(); const first = overview.sessions[0] ?? await api.call('create'); await open(first.id); }
api.onRequest(async request => {
  if (request.kind === 'message') return messages.ask(request.message);
  if (request.kind === 'closeDrafts') return settings.approveQuit();
  flushing ??= (async () => { await commands; if (session) session.draft = collect(); await saveMask(); await flush(); await settings.settleSave(); })().finally(() => { flushing = undefined; });
  return flushing;
});
function dispatchCommand(id: string) {
  if (id === 'beginClose' || id === 'endClose' || id === 'shutdown') {
    if (!closing && id !== 'endClose') closeFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closing = id !== 'endClose';
    if (closing) messages.dismissAll();
    for (const element of document.querySelectorAll<HTMLElement>('body > :not(#appMessage)')) element.inert = id !== 'endClose';
    if (!closing && closeFocus?.isConnected) closeFocus.focus();
    return;
  }
  if (isComposing()) return;
  if (id === 'closeWindow') {
    if (closing) { if (document.querySelector('#appMessage[open]')) closeTopModal(); return; }
    if (!closeTopModal()) void api.call('closeWindow').catch(issue);
    return;
  }
  if (['uiZoomIn', 'uiZoomOut', 'uiZoomReset'].includes(id)) { void api.call('uiZoom', { direction: id === 'uiZoomIn' ? 'in' : id === 'uiZoomOut' ? 'out' : 'reset' }).catch(issue); return; }
  if (id === 'quit') { void api.call('closeWindow').catch(issue); return; }
  if (closing || !loaded) return;
  if (id === 'about') { if (!document.querySelector('dialog[open]')) about.open(); return; }
  const target = document.getElementById(id);
  if (target instanceof HTMLButtonElement && !target.disabled && !document.querySelector('dialog[open]')) target.click();
}
api.onCommand(dispatchCommand); window.addEventListener('pagehide', commandShortcuts(dispatchCommand), { once: true });
let loaded = false;
let layoutReady = false;
let loading = false;
async function boot() {
  if (loading) return;
  loading = true; input('retryStartup').disabled = true;
  try {
    const locale = await api.call('locale');
    document.documentElement.style.setProperty('--font-ui', locale?.uiFont || defaultFont);
    await localize(locale ?? { language: 'en', format: 'en' });
    if (!layoutReady) { await paneLayout(api, issue); layoutReady = true; }
    await start();
    loaded = true; element('startup').hidden = true; element('appViewport').hidden = false;
    await api.call('ready');
  } catch (error) {
    loaded = false;
    console.error('Workspace startup failed.', error);
    // Keep the normal workspace unavailable until all required reads succeed.
    await localize(activeLocale());
    element('appViewport').hidden = true; element('startup').hidden = false; element('startupTitle').focus();
  } finally { loading = false; input('retryStartup').disabled = false; }
}
element('retryStartup').onclick = () => { void boot(); };
element('quitStartup').onclick = () => { void api.call('closeWindow').catch(issue); };
void boot();
