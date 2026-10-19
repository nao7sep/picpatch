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
let painting = false, drawing = false;
const undo: ImageData[] = [], redo: ImageData[] = [];
const mask = element<HTMLCanvasElement>('mask'); const context = mask.getContext('2d')!;
const image = element<HTMLImageElement>('image'); image.crossOrigin = 'anonymous';
let maskDirty = false, maskRevision = 0;
let maskSave = Promise.resolve();
function issue(error: unknown) { element('issue').hidden = false; element('issue').querySelector('span')!.textContent = error instanceof Error ? error.message : String(error); }
function action(id: string, work: () => unknown) { element(id).addEventListener('click', () => { void Promise.resolve().then(work).catch(issue); }); }
const imageUrl = (id: string) => `picpatch-image://${session!.id}/${id}`;
function button(text: string, work: () => unknown) { const b = document.createElement('button'); b.textContent = text; b.onclick = () => { void Promise.resolve().then(work).catch(issue); }; return b; }
function collect(): Draft {
  const d = structuredClone(session!.draft);
  d.mode = input('mode').value as Draft['mode']; d.text = input('text').value;
  d.modelIds = [...element('modelList').querySelectorAll<HTMLInputElement>('input:checked')].map(item => item.value);
  d.width = Number(input('width').value); d.height = Number(input('height').value);
  if (input('seed').value === '') delete d.seed; else d.seed = Number(input('seed').value);
  for (const field of element('parameters').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select,textarea')) {
    const key = field.dataset.key!;
    if (field.value === '') delete (d.parameters as any)[key]; else (d.parameters as any)[key] = field.dataset.numeric ? Number(field.value) : field.value;
  }
  if (input('expand').checked) d.outpaint = { width: Number(input('outWidth').value), height: Number(input('outHeight').value), left: Number(input('outLeft').value), top: Number(input('outTop').value) }; else delete d.outpaint;
  return d;
}
function scheduleSave() { if (!session) return; session.draft = collect(); clearTimeout(saveTimer); saveTimer = setTimeout(() => { void flush().catch(issue); }, 350); }
async function flush() {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (!session) return;
  const id = session.id, draft = structuredClone(session.draft);
  const next = saves.then(() => api.call('draft', { id, draft })).then(() => {});
  saves = next.catch(() => {}); await next;
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
function capabilities() {
  const d = session!.draft; const model = overview.models.find((m: any) => m.id === d.modelIds[0]); const caps: ModelCapabilities | undefined = model?.capabilities;
  element('editControls').hidden = d.mode !== 'edit'; element('run').textContent = d.mode === 'edit' ? 'Edit' : 'Generate';
  element('maskSemantics').textContent = caps?.maskMode === 'composite' || caps?.maskMode === 'latent-composite' ? 'Masked edits preserve normalized pixels outside the edited region.' : caps?.maskMode === 'native' ? 'Native inpainting: pixels outside the mask may change.' : 'This model does not support masks.';
  input('paint').disabled = !d.source || !caps || caps.maskMode === 'none'; input('expand').disabled = !caps?.outpainting;
  const parameters = element('parameters'); parameters.replaceChildren();
  for (const key of ['steps', 'guidance', 'strength', 'identityStyleStrength', 'appearanceStrength', 'sampler', 'scheduler', 'negativePrompt']) {
    const descriptor = (caps?.parameters as any)?.[key]; const existing = (d.parameters as any)[key];
    if (!descriptor && existing === undefined) continue;
    const label = document.createElement('label'); label.append(document.createTextNode(`${key}${descriptor ? '' : ' (unsupported by selected model)'}`));
    let field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (descriptor?.values) { field = document.createElement('select'); const blank = document.createElement('option'); blank.value = ''; blank.textContent = `Default (${descriptor.default})`; field.append(blank); for (const value of descriptor.values) { const opt = document.createElement('option'); opt.value = value; opt.textContent = value; field.append(opt); } }
    else if (key === 'negativePrompt') field = document.createElement('textarea');
    else { field = document.createElement('input'); field.type = 'number'; field.step = descriptor?.integer ? '1' : 'any'; field.dataset.numeric = 'true'; field.placeholder = descriptor?.default === undefined ? 'Default' : String(descriptor.default); }
    field.dataset.key = key; field.value = existing === undefined ? '' : String(existing); field.oninput = scheduleSave; label.append(field); parameters.append(label);
  }
}
function references() {
  const holder = element('references'); holder.replaceChildren();
  for (const [index, group] of session!.draft.references.entries()) {
    const box = document.createElement('div'); box.className = 'reference';
    const name = document.createElement('input'); name.value = group.id; name.setAttribute('aria-label', 'Reference group name'); name.onchange = () => { group.id = name.value; void flush().catch(issue); }; box.append(name);
    const role = document.createElement('select'); for (const value of ['subject','object','style','background']) { const option = document.createElement('option'); option.value = value; option.textContent = value; role.append(option); } role.value = group.role; role.onchange = () => { group.role = role.value as typeof group.role; void flush().catch(issue); }; box.append(role);
    for (const id of group.images) { const img = document.createElement('img'); img.src = imageUrl(id); img.alt = 'Reference'; box.append(img); }
    box.append(button('Add photos', async () => { const added: Asset[] = await api.call('import', { id: session!.id }); group.images.push(...added.map(asset => asset.id)); await refresh(); await flush(); references(); }), button('Remove group', async () => { session!.draft.references.splice(index, 1); await flush(); references(); })); holder.append(box);
  }
  element('sourceName').textContent = session!.draft.source ? session!.assets.find(a => a.id === session!.draft.source)?.name ?? 'Selected result' : 'No source image';
}
function results() {
  const holder = element('results'); holder.replaceChildren();
  for (const run of session!.runs) {
    const b = document.createElement('button'); b.className = `result${selected.includes(run.id) ? ' selected' : ''}`;
    if (run.output) { const img = document.createElement('img'); img.src = imageUrl(run.id); img.alt = ''; b.append(img); }
    const text = document.createElement('div'); text.textContent = `${run.modelId} · ${run.seed} · ${run.status}`; b.append(text);
    b.onclick = event => { void (async () => { await saveMask(); await flush(); if (event.metaKey || event.ctrlKey || event.shiftKey) selected = selected.includes(run.id) ? selected.filter(id => id !== run.id) : [...selected.slice(-1), run.id]; else selected = [run.id]; results(); show(); })().catch(issue); }; holder.append(b);
  }
}
function show() {
  const run = session!.runs.find(r => r.id === selected[selected.length - 1]);
  const asset = run?.output ? run.id : session!.draft.source;
  element('empty').hidden = Boolean(asset); element('imageStage').hidden = !asset;
  if (asset && image.dataset.asset !== asset) { image.dataset.asset = asset; image.src = imageUrl(asset); maskDirty = false; undo.length = 0; redo.length = 0; }
  element('resultInfo').textContent = run ? `${run.status} · ${run.modelId} · seed ${run.seed}${run.issue ? ` · ${run.issue.message}` : ''}` : '';
  input('reuse').disabled = !run; input('editResult').disabled = !run?.output; input('save').disabled = !run?.output; input('saveSettings').disabled = !run?.output;
}
function scale(fit = false) {
  if (!image.naturalWidth) return;
  const canvas = element('canvas'); const ratio = fit ? Math.min((canvas.clientWidth - 32) / image.naturalWidth, (canvas.clientHeight - 32) / image.naturalHeight, 1) : Number(input('zoom').value) / 100;
  image.width = Math.max(1, Math.round(image.naturalWidth * ratio)); image.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  element('imageStage').style.width = `${image.width}px`; element('imageStage').style.height = `${image.height}px`;
}
image.onload = () => {
  mask.width = image.naturalWidth; mask.height = image.naturalHeight; scale(true);
  const owner = session;
  if (owner && image.dataset.asset === owner.draft.source && owner.draft.mask) {
    const saved = new Image(); saved.crossOrigin = 'anonymous'; const sourceId = image.dataset.asset;
    saved.onload = () => { if (image.dataset.asset !== sourceId || drawing || maskDirty) return; context.drawImage(saved, 0, 0); const pixels = context.getImageData(0,0,mask.width,mask.height); for (let i=0;i<pixels.data.length;i+=4) { pixels.data[i+3]=pixels.data[i]!; pixels.data[i]=255; pixels.data[i+1]=255; pixels.data[i+2]=255; } context.putImageData(pixels,0,0); };
    saved.src = imageUrl(owner.draft.mask);
  }
};
function point(event: PointerEvent) { const rect = mask.getBoundingClientRect(); return { x: (event.clientX - rect.left) * mask.width / rect.width, y: (event.clientY - rect.top) * mask.height / rect.height }; }
function stroke(event: PointerEvent) { const p = point(event); context.globalCompositeOperation = input('erase').checked ? 'destination-out' : 'source-over'; context.fillStyle = '#ffffff'; context.beginPath(); context.arc(p.x, p.y, Number(input('brush').value) / 2, 0, Math.PI * 2); context.fill(); maskDirty = true; maskRevision++; }
mask.onpointerdown = event => { if (!painting) return; undo.push(context.getImageData(0,0,mask.width,mask.height)); while (undo.length > 1 && undo.length * mask.width * mask.height * 4 > 64 * 1024 * 1024) undo.shift(); redo.length = 0; drawing = true; mask.setPointerCapture(event.pointerId); stroke(event); };
mask.onpointermove = event => { if (drawing) stroke(event); };
mask.onpointerup = () => { drawing = false; void saveMask().then(flush).catch(issue); };
mask.onpointercancel = () => { drawing = false; void saveMask().then(flush).catch(issue); };
function saveMask(): Promise<void> { const next = maskSave.then(persistMask); maskSave = next.catch(() => {}); return next; }
async function persistMask() {
  if (!maskDirty) return;
  const owner = session!, revision = maskRevision;
  const output = document.createElement('canvas'); output.width = mask.width; output.height = mask.height;
  const ctx = output.getContext('2d')!; ctx.fillStyle = 'black'; ctx.fillRect(0,0,output.width,output.height); ctx.drawImage(mask,0,0);
  const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode mask.')), 'image/png'));
  const asset: Asset = await api.call('mask', { id: owner.id, bytes: new Uint8Array(await blob.arrayBuffer()) });
  owner.draft.mask = asset.id; maskDirty = revision !== maskRevision;
}
async function refresh() {
  overview = await api.call('overview');
  const holder = element('sessionList'); holder.replaceChildren();
  for (const item of overview.sessions) holder.append(button(item.name, () => open(item.id)));
  for (const failure of overview.failures) { const p = document.createElement('p'); p.textContent = failure.message; holder.append(p); }
  if (session) { const fresh: Session = await api.call('get', { id: session.id }); session.runs = fresh.runs; session.assets = fresh.assets; results(); show(); }
  if (overview.historyIssue) issue(overview.historyIssue);
  const active = overview.queue.active;
  element('status').textContent = overview.queue.paused ? `Queue paused: ${overview.queue.issue ?? 'Resume when ready'}` : active ? `${active.stage} · working` : 'Ready';
  element('cancel').hidden = !active;
  const progress = element<HTMLProgressElement>('progress'); progress.hidden = !active?.progress;
  if (active?.progress) { progress.max = active.progress.total; progress.value = active.progress.completed; }
}
async function open(id: string) {
  if (session) { await saveMask(); await flush(); }
  session = await api.call('get', { id }); selected = session!.runs.filter(r => r.output).slice(-1).map(r => r.id); parent = undefined;
  fields(); results(); show();
}
action('new', async () => { await saveMask(); await flush(); const created: Session = await api.call('create'); await refresh(); await open(created.id); });
action('sessionsToggle', () => { element('sessions').hidden = !element('sessions').hidden; return api.call('layout', { sidebar: !element('sessions').hidden }); });
action('import', async () => { const assets: Asset[] = await api.call('import', { id: session!.id }); if (assets[0]) { session!.draft.source = assets[0].id; session!.draft.mode = 'edit'; selected = []; await refresh(); fields(); await flush(); show(); } });
action('clearSource', async () => { delete session!.draft.source; delete session!.draft.mask; maskDirty = false; selected = []; fields(); await flush(); show(); });
action('addReference', async () => { const assets: Asset[] = await api.call('import', { id: session!.id }); if (!assets.length) return; session!.draft.references.push({ id: `reference-${session!.draft.references.length + 1}`, role: 'subject', images: assets.map(a => a.id) }); await refresh(); references(); await flush(); });
action('run', async () => { session!.draft = collect(); await saveMask(); await flush(); await api.call('submit', { id: session!.id, draft: session!.draft, samples: Number(input('samples').value), parent }); await refresh(); });
action('resume', async () => { await api.call('resume', { id: session!.id }); await refresh(); });
action('cancel', async () => { const active = overview.queue.active; if (active) await api.call('cancel', { id: active.sessionId, runId: active.runId }); });
action('reuse', async () => { const run = session!.runs.find(r => r.id === selected.at(-1)); if (!run) return; session!.draft = structuredClone(run.draft); session!.draft.seed = run.seed; session!.draft.modelIds = [run.modelId]; fields(); await flush(); });
action('editResult', async () => { const run = session!.runs.find(r => r.id === selected.at(-1)); if (!run?.output) return; await saveMask(); session!.draft.mode = 'edit'; session!.draft.source = run.id; delete session!.draft.mask; parent = run.id; fields(); await flush(); show(); });
action('fit', () => scale(true)); action('actual', () => { input('zoom').value = '100'; scale(); }); input('zoom').oninput = () => scale();
action('paint', () => { selected = []; show(); painting = !painting; mask.classList.toggle('painting', painting); element('paint').textContent = painting ? 'Finish painting' : 'Paint mask'; });
action('clearMask', async () => { context.clearRect(0,0,mask.width,mask.height); delete session!.draft.mask; maskDirty = false; await flush(); });
action('undoMask', () => { const previous = undo.pop(); if (previous) { redo.push(context.getImageData(0,0,mask.width,mask.height)); context.putImageData(previous,0,0); maskDirty = true; maskRevision++; return saveMask().then(flush); } });
action('redoMask', () => { const next = redo.pop(); if (next) { undo.push(context.getImageData(0,0,mask.width,mask.height)); context.putImageData(next,0,0); maskDirty = true; maskRevision++; return saveMask().then(flush); } });
action('compare', () => { const second = element<HTMLImageElement>('comparison'); if (!second.hidden) { second.hidden = true; scale(true); return; } if (selected.length !== 2) throw new Error('Command-click two completed results to compare.'); const run = session!.runs.find(r => r.id === selected[0]); if (!run?.output) throw new Error('Choose completed results.'); second.src = imageUrl(run.id); second.hidden = false; });
for (const [id, sidecar] of [['save',false], ['saveSettings',true]] as const) action(id, async () => { await flush(); const result = await api.call('export', { id: session!.id, runId: selected.at(-1), sidecar, includeInputs: input('includePrompts').checked }); if (result?.status === 'refused') throw new Error(result.message); if (result?.sidecar?.status === 'failed') throw new Error('Image saved; its settings sidecar could not be saved.'); if (result?.status === 'saved') element('status').textContent = sidecar ? 'Image and settings saved.' : 'Image saved.'; });
action('delete', async () => { const id = session!.id; await api.call('delete', { id }); session = undefined; await start(); });
action('collection', async () => { await saveMask(); await flush(); await api.call('collection'); session = undefined; await start(); });
input('sessionName').onchange = () => { void api.call('rename', { id: session!.id, name: input('sessionName').value }).then(refresh).catch(issue); };
for (const id of ['mode','text','width','height','seed','expand','outWidth','outHeight','outLeft','outTop']) input(id).addEventListener('input', () => { scheduleSave(); if (id === 'mode') capabilities(); });
element('issue').querySelector('button')!.onclick = () => { element('issue').hidden = true; };
const management = element<HTMLDialogElement>('management');
action('manage', async () => { management.showModal(); const select = element<HTMLSelectElement>('manageModel'); select.replaceChildren(); for (const model of overview.models) { const option = document.createElement('option'); option.value = model.id; option.textContent = `${model.id} (${model.evidence ?? 'experimental'})`; select.append(option); } await managed(); });
action('closeManagement', () => management.close());
async function managed() { const inventory = await api.call('models'); element('managedList').replaceChildren(); for (const model of inventory.models) { const p = document.createElement('p'); p.textContent = `${model.id}: ${model.status}`; element('managedList').append(p); } }
for (const [id, command] of [['installNative','installNative'],['installPython','installPython'],['checkEngines','engines']] as const) action(id, async () => { element('engineState').textContent = 'Working…'; try { const result = await api.call(command); element('engineState').textContent = JSON.stringify(result, null, 2); } catch (error) { element('engineState').textContent = String(error); } });
for (const [id, download] of [['download',true],['register',false]] as const) action(id, async () => { element('manageIssue').textContent = 'Preparing model…'; try { await api.call('prepare', { modelId: input('manageModel').value, download }); element('manageIssue').textContent = ''; await managed(); } catch (error) { element('manageIssue').textContent = String(error); } });
element('canvas').ondragover = event => { event.preventDefault(); };
element('canvas').ondrop = event => { event.preventDefault(); const file = event.dataTransfer?.files[0]; if (!file) return; void (async () => { const added: Asset[] = await api.call('import', { id: session!.id, path: api.droppedFile(file) }); session!.draft.source = added[0]!.id; session!.draft.mode = 'edit'; selected = []; await refresh(); fields(); await flush(); show(); })().catch(issue); };
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
api.onChange(() => { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh().catch(issue); }, 100); });
async function start() { await refresh(); const first = overview.sessions[0] ?? await api.call('create'); await open(first.id); }
api.onFlush(async () => { if (session) session.draft = collect(); await saveMask(); await flush(); });
void start().then(() => api.call('ready')).catch(issue);
