import { layout } from '../shared/layout.ts';
import type { Bridge } from '../shared/bridge.ts';
export async function paneLayout(api: Bridge, report: (error: unknown) => void) {
  const state = await api.call('paneState');
  const workspace = document.getElementById('workspace')!;
  const request = document.getElementById('request')!;
  const sidebar = document.getElementById('sessions')!;
  const splitter = document.getElementById('requestSplitter')!;
  sidebar.hidden = !state.sidebar;
  function paint() {
    const maximum = workspace.clientWidth - layout.canvas - layout.divider - (sidebar.hidden ? 0 : layout.sidebar + layout.divider);
    request.style.width = `${Math.max(layout.request, Math.min(state.requestWidth, maximum))}px`;
    splitter.setAttribute('aria-valuenow', String(Math.round(request.getBoundingClientRect().width)));
  }
  async function save() { await api.call('paneState', state); }
  document.getElementById('sessionsToggle')!.onclick = () => {
    sidebar.hidden = !sidebar.hidden; state.sidebar = !sidebar.hidden; paint();
    void api.call('layout', { sidebar: state.sidebar }).then(save).catch(report);
  };
  let dragging = false;
  splitter.addEventListener('pointerdown', event => { dragging = true; splitter.setPointerCapture(event.pointerId); event.preventDefault(); });
  splitter.addEventListener('pointermove', event => {
    if (!dragging) return;
    const left = request.getBoundingClientRect().left;
    const maximum = workspace.clientWidth - layout.canvas - layout.divider - (sidebar.hidden ? 0 : layout.sidebar + layout.divider);
    state.requestWidth = Math.max(layout.request, Math.min(event.clientX - left, maximum)); paint();
  });
  splitter.addEventListener('pointerup', () => { if (dragging) { dragging = false; void save().catch(report); } });
  splitter.addEventListener('pointercancel', () => { dragging = false; });
  splitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); state.requestWidth = event.key === 'Home' ? layout.request : Math.max(layout.request, state.requestWidth + (event.key === 'ArrowRight' ? 20 : -20)); paint(); void save().catch(report);
  });
  new ResizeObserver(paint).observe(workspace);
  paint(); await api.call('layout', { sidebar: state.sidebar });
}
