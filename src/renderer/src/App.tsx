// The main window: the session rail, the open session's transcript and composer, the
// options pane and the one modal stack. App is the single writer of the window's
// state; the panes receive what they show and report what the user did.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Draft, ReferenceDraft, Run, Session } from '../../shared/session.ts';
import { afterCommand, canPaintMask, imageCommand, maskNote, recoverCommand, targetImage, withoutTarget } from '../../shared/image-command.ts';
import { errorText as describeError, message, t, useLocale } from '../../shared/i18n/index.ts';
import { layout, minimum } from '../../shared/layout.ts';
import type { RendererRequest } from '../../shared/messages.ts';
import { setCatalog } from './models.ts';
import { api, imageUrl, type LocaleState, type Overview, type PaneState, type Readiness } from './api.ts';
import { commandIssues } from './command-issues.ts';
import { Composer } from './components/Composer.tsx';
import { Conversation, type ViewItem } from './components/Conversation.tsx';
import { CloseIcon, ResumeIcon } from './components/icons.tsx';
import { OptionsPane } from './components/OptionsPane.tsx';
import { Rail } from './components/Rail.tsx';
import { DraftWriter } from './draft-writer.ts';
import { applyFont } from './fonts.ts';
import { LanguageRevision, useI18n } from './i18n.tsx';
import { isComposing } from './ime.ts';
import { ManagementModal } from './modals/ManagementModal.tsx';
import { MaskModal } from './modals/MaskModal.tsx';
import { MessageModal, useMessages } from './modals/MessageModal.tsx';
import { closeTopModal, modalOpen, onModalCount } from './modals/Modal.tsx';
import { ReferenceModal } from './modals/ReferenceModal.tsx';
import { SettingsModal, type SettingsGuard } from './modals/SettingsModal.tsx';
import { SetupModal } from './modals/SetupModal.tsx';
import { AboutModal, ExportModal, RenameModal, ShortcutsModal } from './modals/SmallModals.tsx';
import { ViewerModal } from './modals/ViewerModal.tsx';
import { commandShortcuts } from './shortcuts.ts';
import { StartupFailure } from './StartupFailure.tsx';
import { imageLabel } from './transcript.ts';

type ModalSpec =
  | { kind: 'settings' } | { kind: 'setup'; modelId?: string } | { kind: 'manage'; modelId?: string }
  | { kind: 'about' } | { kind: 'shortcuts' } | { kind: 'rename' }
  | { kind: 'export'; runId: string; sidecar: boolean }
  | { kind: 'viewer'; items: ViewItem[]; index: number }
  | { kind: 'mask' } | { kind: 'reference'; index: number };

interface Notice { key: string; error: unknown }
const LIFETIME = ['beginClose', 'endClose', 'shutdown'];

export function App() {
  const [revision, setRevision] = useState(-1);
  const [phase, setPhase] = useState<'loading' | 'failed' | 'unavailable' | 'ready'>('loading');
  const [missingCollection, setMissingCollection] = useState('');
  const [overview, setOverview] = useState<Overview>();
  const [readiness, setReadiness] = useState<Readiness>();
  const [session, setSession] = useState<Session>();
  const [draft, setDraftState] = useState<Draft>();
  const [pane, setPane] = useState<PaneState>({ railWidth: layout.railDefault, optionsPane: false });
  const [modals, setModals] = useState<ModalSpec[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  /** The backup notice the user dismissed; a different one shows again. */
  const [historyDismissed, setHistoryDismissed] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [samples, setSamples] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<{ runId: string; count: number }>();
  const [modalCount, setModalCount] = useState(0);
  const messages = useMessages();

  const sessionRef = useRef<Session>(undefined);
  const draftRef = useRef<Draft>(undefined);
  const overviewRef = useRef<Overview>(undefined);
  const loaded = useRef(false);
  const closingRef = useRef(false);
  const closeFocus = useRef<HTMLElement | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const settingsGuard = useRef<SettingsGuard>(null);
  /** Whether the front modal holds an unsaved edit (a painted mask, a typed name) that quitting would discard. */
  const modalDraft = useRef(false);
  const markDraft = useCallback((dirty: boolean) => { modalDraft.current = dirty; }, []);
  const focusComposer = useRef<() => void>(() => {});
  const composerBox = useRef<HTMLDivElement>(null);
  const revisionRef = useRef(-1); revisionRef.current = revision;

  const show = useCallback((key: string, error: unknown) => setNotices(items => [...items.filter(item => item.key !== key), { key, error }]), []);
  const clear = useCallback((key: string) => setNotices(items => items.some(item => item.key === key) ? items.filter(item => item.key !== key) : items), []);
  const writer = useMemo(() => new DraftWriter((id, value) => api.saveDraft(id, value), error => error === undefined ? clear('draft') : show('draft', error)), [clear, show]);
  useEffect(() => () => writer.dispose(), [writer]);

  /** UI commands run one after another; each owns its failure notice until it next succeeds. */
  const command = useCallback((key: string, work: () => unknown) => {
    const next = chain.current.then(work);
    chain.current = next.then(() => clear(key), error => show(key, error));
    return chain.current;
  }, [clear, show]);

  const applyLocale = useCallback(async (locale: LocaleState) => {
    const changed = await useLocale(locale);
    document.documentElement.lang = locale.language;
    if (changed || revisionRef.current < 0) setRevision(value => value + 1);
  }, []);
  const applyOverview = useCallback(async (next: Overview) => {
    setCatalog(next.models); overviewRef.current = next; setOverview(next);
    applyFont(next.settings.uiFont);
    await applyLocale(next.locale);
  }, [applyLocale]);
  const refreshOverview = useCallback(async () => { const next = await api.overview(); await applyOverview(next); return next; }, [applyOverview]);
  const checkModels = useCallback(async () => {
    try { const next = await api.readiness(); setReadiness(next); clear('readiness'); return next; }
    catch (error) { setReadiness({}); show('readiness', error); return {}; }
  }, [clear, show]);

  const load = useCallback((next: Session) => {
    sessionRef.current = next; setSession(next);
    draftRef.current = next.draft; setDraftState(next.draft);
    void api.focus(next.id).catch(() => {});
  }, []);
  const patchSession = useCallback((change: (value: Session) => Session) => {
    const owner = sessionRef.current; if (!owner) return;
    const next = change(owner); sessionRef.current = next; setSession(next);
  }, []);
  const updateDraft = useCallback((next: Draft, save: 'later' | 'now' | 'none' = 'now') => {
    const value = imageCommand(next); draftRef.current = value; setDraftState(value);
    const owner = sessionRef.current; if (!owner || save === 'none') return;
    if (save === 'later') writer.later(owner.id, value); else void writer.now(owner.id, value).catch(() => {});
  }, [writer]);

  const start = useCallback(async (current: Overview) => {
    const first = current.sessions[0] ?? await api.create();
    load(await api.get(first.id));
    if (!current.sessions[0]) await refreshOverview();
  }, [load, refreshOverview]);

  const boot = useCallback(async () => {
    setPhase('loading');
    try {
      const locale = await api.locale(); applyFont(locale.uiFont); await applyLocale(locale);
      const state = await api.paneState(); setPane({ railWidth: state.railWidth, optionsPane: state.optionsPane });
      const ready = await checkModels();
      const current = await refreshOverview();
      // A missing collection is reported, never recreated; another one can be opened instead.
      if (current.unavailable) { loaded.current = false; setMissingCollection(current.unavailable.path); setPhase('unavailable'); return; }
      await start(current);
      loaded.current = true; setPhase('ready');
      if (Object.keys(ready).length && !Object.values(ready).includes('ready')) setModals([{ kind: 'setup' }]);
    } catch (error) {
      // The workspace stays unavailable until every required read succeeds.
      console.error('Workspace startup failed.', error);
      loaded.current = false; setRevision(value => Math.max(0, value)); setPhase('failed');
    }
  }, [applyLocale, checkModels, refreshOverview, start]);
  // Boot once per page, including under StrictMode's development double effects: a first run creates a session.
  const booted = useRef(false);
  useEffect(() => { if (booted.current) return; booted.current = true; void boot(); }, [boot]);
  useEffect(() => { if (phase === 'ready') void api.ready(); }, [phase]);

  const refresh = useCallback(async () => {
    await refreshOverview();
    const owner = sessionRef.current; if (!owner) return;
    const fresh = await api.get(owner.id);
    if (sessionRef.current?.id !== owner.id) return;
    // The backend's runs and assets replace ours; the draft being edited stays local.
    patchSession(() => ({ ...fresh, draft: draftRef.current ?? fresh.draft }));
    const current = draftRef.current;
    if (current) { const recovered = recoverCommand(current, fresh.runs); if (recovered !== current) updateDraft(recovered, 'now'); }
  }, [patchSession, refreshOverview, updateDraft]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return api.onChange(() => {
      if (!loaded.current || timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh().then(() => clear('refresh'), error => show('refresh', error)); }, 100);
    });
  }, [clear, refresh, show]);
  // Progress replaces only the queue state; sessions are reloaded when a run settles.
  useEffect(() => api.onQueue(queue => {
    const current = overviewRef.current; if (!loaded.current || !current) return;
    const next = { ...current, queue }; overviewRef.current = next; setOverview(next);
  }), []);

  const push = useCallback((spec: ModalSpec) => setModals(items => [...items, spec]), []);
  const pop = useCallback(() => { modalDraft.current = false; setModals(items => items.slice(0, -1)); }, []);
  useEffect(() => onModalCount(setModalCount), []);
  const anyModal = modalCount > 0;
  useEffect(() => { if (phase === 'ready') void api.modalState(anyModal).catch(() => {}); }, [anyModal, phase]);

  // One discard question everywhere; quitting names the quit, and Keep editing is the safe default.
  const confirm = useCallback(async (ending: 'close' | 'quit' = 'close') => await messages.ask({
    title: message('discard.title'), detail: message(ending === 'quit' ? 'discard.quitBody' : 'discard.body'),
    actions: [{ label: message('discard.keep') }, { label: message('discard.confirm'), destructive: true }],
  }) === 1, [messages]);

  // ---- Session commands ----
  const open = useCallback((id: string) => command('open', async () => {
    if (sessionRef.current?.id === id) return;
    await writer.flush();
    load(await api.get(id));
  }), [command, load, writer]);
  const newSession = useCallback(() => command('new', async () => {
    await writer.flush();
    const created = await api.create();
    await refreshOverview(); load(await api.get(created.id));
    setTimeout(() => focusComposer.current(), 0);
  }), [command, load, refreshOverview, writer]);
  const restart = useCallback(async () => { sessionRef.current = undefined; await start(await refreshOverview()); }, [refreshOverview, start]);
  const deleteSession = useCallback(() => command('delete', async () => {
    const owner = sessionRef.current; if (!owner) return;
    await writer.flush();
    if (await api.remove(owner.id)) await restart();
  }), [command, restart, writer]);
  const openCollection = useCallback(() => command('collection', async () => {
    await writer.flush();
    if (await api.collection()) await restart();
  }), [command, restart, writer]);

  // ---- Composer commands ----
  const addAssets = useCallback((assets: Asset[]) => patchSession(value => ({ ...value, assets: [...value.assets, ...assets.filter(asset => !value.assets.some(item => item.id === asset.id))] })), [patchSession]);
  const group = (images: string[]): ReferenceDraft => {
    const references = draftRef.current?.references ?? [];
    const ids = new Set(references.map(reference => reference.id));
    let number = references.length + 1;
    let id = t('reference.name', { number });
    while (ids.has(id)) id = t('reference.name', { number: ++number });
    return { id, role: 'subject', images };
  };
  const attachTarget = useCallback(() => command('import', async () => {
    const owner = sessionRef.current; if (!owner) return;
    const assets = await api.importImages(owner.id, undefined, false);
    if (!assets[0]) return;
    addAssets(assets); updateDraft(targetImage(draftRef.current!, assets[0].id));
    focusComposer.current();
  }), [addAssets, command, updateDraft]);
  const addReference = useCallback(() => command('addReference', async () => {
    const owner = sessionRef.current; if (!owner) return;
    const assets = await api.importImages(owner.id);
    if (!assets.length) return;
    addAssets(assets); updateDraft({ ...draftRef.current!, references: [...draftRef.current!.references, group(assets.map(asset => asset.id))] });
  }), [addAssets, command, updateDraft]);
  const dropFiles = useCallback((files: File[]) => command('import', async () => {
    const owner = sessionRef.current; if (!owner) return;
    const paths = files.map(file => api.droppedFile(file)).filter(Boolean);
    // Every file that can be imported is kept and used; the first failure is reported afterwards.
    const assets: Asset[] = []; let failure: unknown;
    for (const path of paths) { try { assets.push(...await api.importImages(owner.id, path)); } catch (error) { failure ??= error; } }
    if (!assets.length) { if (failure) throw failure; return; }
    addAssets(assets);
    const current = draftRef.current!;
    // With nothing being edited, one image becomes the image to edit; otherwise the drop is a reference group.
    if (!current.source && assets.length === 1) updateDraft(targetImage(current, assets[0]!.id));
    else updateDraft({ ...current, references: [...current.references, group(assets.map(asset => asset.id))] });
    if (failure) throw failure;
  }), [addAssets, command, updateDraft]);
  const chooseControl = useCallback((kind: NonNullable<Draft['control']>['kind']) => command('addControl', async () => {
    const owner = sessionRef.current; if (!owner) return;
    const [asset] = await api.importImages(owner.id, undefined, false);
    if (!asset) return;
    addAssets([asset]); updateDraft({ ...draftRef.current!, control: { image: asset.id, kind } });
  }), [addAssets, command, updateDraft]);

  const issues = session && draft && overview ? commandIssues(session, draft, overview.models, readiness) : [];
  const send = useCallback(() => command('run', async () => {
    const owner = sessionRef.current, current = draftRef.current, models = overviewRef.current?.models;
    if (!owner || !current || !models || !current.text.trim() || commandIssues(owner, current, models, readiness).length) return;
    setSubmitting(true);
    try {
      await writer.flush();
      const runs = await api.submit(owner.id, current, samples);
      // The backend saved this same next draft with the submission.
      const next = afterCommand(current, runs[0]!.id);
      patchSession(value => ({ ...value, runs: [...value.runs, ...runs.filter(run => !value.runs.some(item => item.id === run.id))] }));
      const typed = draftRef.current;
      if (typed === current) { draftRef.current = next; setDraftState(next); }
      // Text typed while the command was being sent is the next instruction; keep it, aimed at the new result.
      else updateDraft({ ...next, text: typed?.text ?? '' }, 'now');
    } finally { setSubmitting(false); focusComposer.current(); }
  }), [command, patchSession, readiness, samples, updateDraft, writer]);

  // Only an image that exists opens the mask window; a pending result would leave it unseen, to open on its own later.
  const paintMask = useCallback(() => {
    const owner = sessionRef.current, current = draftRef.current;
    const model = overviewRef.current?.models.find(item => item.id === current?.modelIds[0]);
    if (owner && current && canPaintMask(owner, current, model?.capabilities.maskMode)) push({ kind: 'mask' });
  }, [push]);
  const editThis = useCallback((runId: string) => {
    setModals(items => items.filter(item => item.kind !== 'viewer'));
    updateDraft(targetImage(draftRef.current!, runId));
    setTimeout(() => focusComposer.current(), 0);
  }, [updateDraft]);
  const reuse = useCallback((run: Run) => {
    setModals(items => items.filter(item => item.kind !== 'viewer'));
    updateDraft({ ...structuredClone(run.draft), seed: run.seed, modelIds: [run.modelId] });
    setTimeout(() => focusComposer.current(), 0);
  }, [updateDraft]);
  const cancelRuns = useCallback((ids: string[]) => command('cancel', async () => {
    const owner = sessionRef.current; if (!owner) return;
    for (const id of ids) await api.cancel(owner.id, id);
  }), [command]);
  const resume = useCallback(() => command('resume', async () => { const owner = sessionRef.current; if (owner) await api.resume(owner.id); }), [command]);
  const saveTarget = (sidecar: boolean) => {
    const owner = sessionRef.current; if (!owner) return;
    const source = owner.runs.find(run => run.id === draftRef.current?.source && run.output);
    const run = source ?? owner.runs.filter(item => item.output).at(-1);
    if (run) push({ kind: 'export', runId: run.id, sidecar });
  };
  const toggleOptions = useCallback(() => setPane(value => { const next = { ...value, optionsPane: !value.optionsPane }; void api.savePane(next).catch(error => show('layout', error)); return next; }), [show]);
  const setRailWidth = useCallback((railWidth: number) => setPane(value => { const next = { ...value, railWidth }; void api.savePane(next).catch(error => show('layout', error)); return next; }), [show]);

  // ---- Native and keyboard commands ----
  const dispatch = (id: string) => {
    if (LIFETIME.includes(id)) {
      const closingNow = id !== 'endClose';
      if (closingNow && !closingRef.current) closeFocus.current = document.activeElement as HTMLElement | null;
      closingRef.current = closingNow; setClosing(closingNow);
      if (closingNow) { messages.dismissAll(); setModals(items => items.filter(item => item.kind !== 'export')); }
      else if (closeFocus.current?.isConnected) closeFocus.current.focus();
      return;
    }
    if (isComposing()) return;
    if (id === 'closeWindow') {
      if (closingRef.current) { if (messages.current) messages.answer(undefined); return; }
      if (!closeTopModal()) void api.closeWindow().catch(error => show('close', error));
      return;
    }
    if (id === 'uiZoomIn' || id === 'uiZoomOut' || id === 'uiZoomReset') { void api.zoom(id === 'uiZoomIn' ? 'in' : id === 'uiZoomOut' ? 'out' : 'reset').catch(error => show('zoom', error)); return; }
    if (id === 'quit') { void api.closeWindow().catch(error => show('close', error)); return; }
    if (closingRef.current || !loaded.current || modalOpen()) return;
    switch (id) {
      case 'new': void newSession(); break;
      case 'collection': void openCollection(); break;
      case 'import': void attachTarget(); break;
      case 'save': saveTarget(false); break;
      case 'saveSettings': saveTarget(true); break;
      case 'run': void send(); break;
      case 'settingsButton': push({ kind: 'settings' }); break;
      case 'manage': push({ kind: 'manage', modelId: draftRef.current?.modelIds[0] }); break;
      case 'setup': push({ kind: 'setup' }); break;
      case 'shortcutsButton': push({ kind: 'shortcuts' }); break;
      case 'showRecords': void api.openRecords().catch(error => show('records', error)); break;
      case 'about': push({ kind: 'about' }); break;
    }
  };
  const dispatchRef = useRef(dispatch); dispatchRef.current = dispatch;
  useEffect(() => api.onCommand(id => dispatchRef.current(id)), []);
  useEffect(() => commandShortcuts(id => dispatchRef.current(id)), []);

  // Main's questions and the quit handshake. Registered once; reads the latest state through refs.
  const requestRef = useRef<(request: RendererRequest) => Promise<unknown>>(async () => undefined);
  requestRef.current = async request => {
    if (request.kind === 'message') return messages.ask(request.message);
    if (request.kind === 'closeDrafts') {
      if (settingsGuard.current) return settingsGuard.current.approveQuit();
      return !modalDraft.current || await confirm('quit');
    }
    // Capture the draft first: an open picker or import in the command chain must not delay or block it.
    await writer.flush(); await settingsGuard.current?.settleSave();
  };
  // The bridge offers no unsubscribe, so the listener is registered once per page.
  const listening = useRef(false);
  useEffect(() => { if (listening.current) return; listening.current = true; api.onRequest(request => requestRef.current(request)); void api.listening().catch(() => {}); }, []);

  // The invisible drop boundary: a file dropped anywhere but the composer is refused, never opened.
  useEffect(() => {
    const deny = (event: DragEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('[data-drop-receiver]') || modalOpen()) {
        event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      }
    };
    window.addEventListener('dragover', deny); window.addEventListener('drop', deny);
    return () => { window.removeEventListener('dragover', deny); window.removeEventListener('drop', deny); };
  }, []);

  // The native window floor follows the panes: rail, stage, the options pane when shown, and the composer's height.
  useEffect(() => {
    if (phase !== 'ready') return;
    const element = composerBox.current; if (!element) return;
    let sent = '';
    const report = () => {
      const floor = { optionsPane: pane.optionsPane, height: Math.ceil(layout.header + layout.transcript + element.getBoundingClientRect().height) };
      const key = JSON.stringify(floor); if (key === sent) return; sent = key;
      void api.layout(floor).catch(() => {});
    };
    const observer = new ResizeObserver(report); observer.observe(element); report();
    return () => observer.disconnect();
  }, [phase, pane.optionsPane]);

  if (revision < 0) return null;
  return (
    <LanguageRevision value={revision}>
      {phase === 'failed' || phase === 'unavailable' ? <StartupFailure retrying={false} onRetry={() => void boot()} onQuit={() => void api.closeWindow()} {...phase === 'unavailable' ? { collection: missingCollection, onOpenCollection: () => void api.collection().then(chosen => { if (chosen) void boot(); }, error => console.error('Collection change failed.', error)) } : {}} />
        : phase === 'loading' || !overview || !session || !draft ? <div className="shell loading" aria-busy="true" />
        : (
          <>
            <div className="shell" inert={closing} style={{ minWidth: minimum(pane.optionsPane).width, minHeight: minimum(pane.optionsPane).height }}>
              <Rail
                sessions={overview.sessions} failures={overview.failures.length} currentId={session.id} working={new Set(overview.queue.active.map(item => item.sessionId))}
                width={pane.railWidth} optionsPane={pane.optionsPane} onWidth={setRailWidth}
                onOpen={id => void open(id)} onNew={() => void newSession()} onRename={() => push({ kind: 'rename' })} onDelete={() => void deleteSession()}
                onMenu={dispatch}
              />
              <main className="stage">
                <Conversation
                  session={session} queue={overview.queue} target={draft.source} optionsPane={pane.optionsPane} saved={saved}
                  onRename={() => push({ kind: 'rename' })} onToggleOptions={toggleOptions} onEditThis={editThis} onReuse={reuse}
                  onView={(items, index) => push({ kind: 'viewer', items, index })} onSave={runId => push({ kind: 'export', runId, sidecar: false })} onCancel={ids => void cancelRuns(ids)}
                />
                <div ref={composerBox} className="stage-foot">
                  <StageNotices
                    notices={notices} onDismiss={clear} queue={overview.queue} session={session} onResume={() => void resume()}
                    history={JSON.stringify(overview.historyIssue ?? null) === historyDismissed ? undefined : overview.historyIssue} onDismissHistory={() => setHistoryDismissed(JSON.stringify(overview.historyIssue ?? null))}
                  />
                  <Composer
                    session={session} draft={draft} models={overview.models} hiddenModels={overview.unsupportedModels} readiness={readiness} issues={issues} submitting={submitting}
                    optionsPane={pane.optionsPane} focusRef={focusComposer} onDraft={updateDraft} onSend={() => void send()}
                    onAttachTarget={() => void attachTarget()} onAddReference={() => void addReference()} onDrop={files => void dropFiles(files)}
                    onClearTarget={() => updateDraft(withoutTarget(draftRef.current!))} onPaintMask={paintMask}
                    onEditReference={index => push({ kind: 'reference', index })}
                    onRemoveReference={index => updateDraft({ ...draftRef.current!, references: draftRef.current!.references.filter((_, i) => i !== index) })}
                    onToggleOptions={toggleOptions} onSetup={() => push({ kind: 'setup', modelId: draft.modelIds.find(id => readiness?.[id] !== 'ready') })}
                  />
                </div>
              </main>
              {pane.optionsPane && (
                <OptionsPane
                  session={session} draft={draft} models={overview.models} samples={samples} onSamples={setSamples} onDraft={updateDraft}
                  onPaintMask={paintMask} onChooseControl={kind => void chooseControl(kind)} onClose={toggleOptions}
                />
              )}
              {modals.length > 0 && renderModal(modals[modals.length - 1]!)}
            </div>
          </>
        )}
      {messages.current && <MessageModal message={messages.current.message} onAnswer={messages.answer} />}
    </LanguageRevision>
  );

  // Only the front surface is drawn; the ones under it come back as it closes.
  function renderModal(spec: ModalSpec) {
    const owner = session!, current = draft!, models = overview!.models;
    switch (spec.kind) {
      case 'settings': return <SettingsModal overview={overview!} guard={settingsGuard} onClose={pop} confirmDiscard={confirm} onSaved={next => { void applyOverview(next); void checkModels(); }} />;
      case 'setup': return <SetupModal models={models} initial={spec.modelId} onClose={pop}
        onChanged={async () => { const next = await checkModels(); await refreshOverview(); return next; }}
        onUse={id => { updateDraft({ ...draftRef.current!, modelIds: [id] }); pop(); }}
        onManage={id => setModals(items => [...items.slice(0, -1), { kind: 'manage', modelId: id }])} />;
      case 'manage': return <ManagementModal models={models} initial={spec.modelId} nativeExecutable={overview!.settings.profile.nativeExecutable} onClose={pop}
        onChanged={async () => { const next = await checkModels(); await refreshOverview(); return next; }} />;
      case 'about': return <AboutModal onClose={pop} />;
      case 'shortcuts': return <ShortcutsModal onClose={pop} />;
      case 'rename': return <RenameModal name={owner.name} onClose={pop} onDirty={markDraft} confirmDiscard={() => confirm()} onRename={async name => {
        try { const renamed = await api.rename(owner.id, name); patchSession(value => ({ ...value, name: renamed.name })); pop(); await refreshOverview(); return undefined; }
        catch (error) { return describeError(error); }
      }} />;
      case 'export': return <ExportModal sessionId={owner.id} runId={spec.runId} label={imageLabel(owner, spec.runId, t)} initialSidecar={spec.sidecar} onClose={pop} onSave={async (sidecar, includeInputs) => {
        try {
          await writer.flush();
          const result = await api.exportImage(owner.id, spec.runId, sidecar, includeInputs);
          if (!result || closingRef.current) return undefined;
          if (result.status === 'refused') return result.code === 'OUTPUT_CONFLICT' ? t('export.exists') : describeError(result);
          // A save that finishes after its dialog was dismissed must not close what is now in front.
          setModals(items => items.at(-1) === spec ? items.slice(0, -1) : items); setSaved(value => ({ runId: spec.runId, count: (value?.runId === spec.runId ? value.count : 0) + 1 }));
          if (result.sidecar?.status === 'failed') show('export', { notice: message('ui.image_saved_its_settings_sidecar_could_not_be_saved') }); else clear('export');
          return undefined;
        } catch (error) { return describeError(error); }
      }} />;
      case 'viewer': return <ViewerModal session={owner} items={spec.items} index={spec.index} onClose={pop} onEditThis={editThis} onReuse={reuse}
        onSave={(runId, at) => setModals(items => [...items.slice(0, -1), { ...spec, index: at }, { kind: 'export', runId, sidecar: false }])} />;
      case 'mask': {
        const model = models.find(item => item.id === current.modelIds[0]);
        if (!current.source || !canPaintMask(owner, current, model?.capabilities.maskMode)) return null;
        return <MaskModal source={imageUrl(owner.id, current.source)} mask={current.mask ? imageUrl(owner.id, current.mask) : undefined}
          note={t(maskNote(model?.capabilities.maskMode))}
          onClose={pop} confirmDiscard={() => confirm()} onDirty={markDraft}
          onDone={async bytes => {
            try {
              if (!bytes) { const next = { ...draftRef.current! }; delete next.mask; updateDraft(next); pop(); return undefined; }
              const asset = await api.saveMask(owner.id, bytes);
              addAssets([asset]); updateDraft({ ...draftRef.current!, mask: asset.id }); pop(); return undefined;
            } catch (error) { return describeError(error); }
          }} />;
      }
      case 'reference': {
        const value = current.references[spec.index];
        if (!value) return null;
        const replace = (next: ReferenceDraft, save: 'later' | 'now') => updateDraft({ ...draftRef.current!, references: draftRef.current!.references.map((item, i) => i === spec.index ? next : item) }, save);
        return <ReferenceModal session={owner} group={value} models={models.filter(model => current.modelIds.includes(model.id))} onClose={pop} onChange={replace}
          onRemove={() => { updateDraft({ ...draftRef.current!, references: draftRef.current!.references.filter((_, i) => i !== spec.index) }); pop(); }}
          onAddPhotos={() => void command('addPhotos', async () => {
            const assets = await api.importImages(owner.id); if (!assets.length) return;
            addAssets(assets); const latest = draftRef.current!.references[spec.index]!;
            replace({ ...latest, images: [...latest.images, ...assets.map(asset => asset.id)] }, 'now');
          })} />;
      }
    }
  }
}

/** Results the stage keeps above the composer: failed commands, the backup notice and a paused queue. */
function StageNotices({ notices, onDismiss, queue, session, onResume, history, onDismissHistory }: {
  notices: Notice[]; onDismiss: (key: string) => void; queue: Overview['queue']; session: Session; onResume: () => void;
  history: Overview['historyIssue']; onDismissHistory: () => void;
}) {
  const { t, errorText } = useI18n();
  const waiting = queue.paused || (session.runs.some(run => run.status === 'queued') && !queue.active.length);
  return (
    <div className="stage-notices">
      {waiting && (
        <div className="notice notice-warn" role="status">
          <span>{queue.paused ? t('run.paused', { reason: queue.issue ? errorText(queue.issue) : t('ui.resume_when_ready') }) : t('conversation.queuedWaiting')}</span>
          <button type="button" className="button compact" onClick={onResume}><ResumeIcon /><span>{t('ui.resume_queued')}</span></button>
        </div>
      )}
      {history && (
        <div className="notice notice-warn" role="status">
          <span>{errorText(history)}</span>
          <button type="button" className="icon-button tiny" onClick={onDismissHistory} aria-label={t('ui.clear_message')} title={t('ui.clear_message')}><CloseIcon /></button>
        </div>
      )}
      {notices.map(notice => (
        <div key={notice.key} className="notice notice-error" role="alert">
          <span>{errorText(notice.error)}</span>
          <button type="button" className="icon-button tiny" onClick={() => onDismiss(notice.key)} aria-label={t('ui.clear_message')} title={t('ui.clear_message')}><CloseIcon /></button>
        </div>
      ))}
    </div>
  );
}
