// The renderer's typed view of the preload bridge. Main owns every effect; these
// wrappers only name the actions and their shapes.
import type { Bridge } from '../../shared/bridge.ts';
import { thumbnailSize } from '../../shared/layout.ts';
import type { Asset, Draft, QueueState, Run, Session, SessionSummary } from '../../shared/session.ts';
import type { RendererRequest } from '../../shared/messages.ts';
import type { Language, Message } from '../../shared/i18n/index.ts';
import type { Evidence, ModelCapabilities, ModelProfile, Operation } from 'picpatchsdk/types';

declare global { interface Window { picpatch: Bridge } }

export interface CatalogModel {
  id: string; variant: string; family: string; acquisition: 'pinned' | 'external';
  capabilities: ModelCapabilities; runtime: { name: string }; downloadBytes?: number;
  evidence: Evidence; tested: Operation[]; profile: ModelProfile;
}
export type ModelState = 'ready' | 'missing' | 'engineMissing';
export type Readiness = Record<string, ModelState>;
export interface LocaleState { language: Language; format: string; systemLanguage?: string; uiFont?: string }
export interface ResourcePaths { engineDirectory?: string; modelsDirectory?: string; nativeExecutable?: string }
export interface AppSettings { profile: ResourcePaths; uiFont?: string; theme?: 'light' | 'dark'; language?: Language; concurrency?: number }
export interface Overview {
  sessions: SessionSummary[]; failures: { id: string; message: string }[]; unavailable?: { path: string; code?: string }; models: CatalogModel[];
  /** Catalog models with no build for this computer, left out of models. */
  unsupportedModels: number; queue: QueueState;
  historyIssue?: string | { message: string; notice?: Message }; settings: AppSettings;
  locations: { engineDirectory?: string; modelsDirectory?: string; sessionsDirectory: string };
  resourcesBusy: boolean; locale: LocaleState; systemDark: boolean;
}
export interface PaneState { railWidth: number; optionsPane: boolean }
export interface ExportResult { status: 'saved' | 'refused'; code?: string; message?: string; effect?: string; sidecar?: { status: string } }
export interface EngineStatus { status: string }
export interface Engines { python: EngineStatus; native: EngineStatus }
export interface ManagedEntry { modelId: string; name: string; bytes: number }
export interface Inventory { entries: ManagedEntry[] }
export interface Components { vae?: string; clipL?: string; clipG?: string; t5?: string; photoMaker?: string; ipAdapter?: string; clipVision?: string; controlNet?: { path: string; kind: string }; loras?: { path: string; scale?: number }[] }
export type Preferences = ResourcePaths & { theme?: 'light' | 'dark'; language?: Language; uiFont?: string; concurrency?: number };

const call = <T>(action: string, payload?: unknown): Promise<T> => window.picpatch.call(action, payload);

export const api = {
  locale: () => call<LocaleState>('locale'),
  ready: () => call<void>('ready'),
  /** Main may now send questions and flush requests, even before the workspace loads. */
  listening: () => call<void>('listening'),
  reportError: (error: { message: string; stack?: string }) => call<void>('renderer-error', error),
  overview: () => call<Overview>('overview'),
  readiness: () => call<Readiness>('modelReadiness'),
  paneState: () => call<PaneState>('paneState'),
  savePane: (state: PaneState) => call<void>('paneState', state),
  layout: (floor: { optionsPane: boolean; height: number }) => call<void>('layout', floor),
  modalState: (open: boolean) => call<void>('modalState', { open }),
  closeWindow: () => call<void>('closeWindow'),
  zoom: (direction: 'in' | 'out' | 'reset') => call<void>('uiZoom', { direction }),
  openRecords: () => call<void>('openLogs'),
  openProjectLink: (destination: 'repository' | 'issues') => call<void>('openProjectLink', { destination }),
  create: () => call<Session>('create'),
  get: (id: string) => call<Session>('get', { id }),
  saveDraft: (id: string, draft: Draft) => call<void>('draft', { id, draft }),
  /** The open session's queued runs take the next free slot. */
  focus: (id: string) => call<void>('focus', { id }),
  rename: (id: string, name: string) => call<Session>('rename', { id, name }),
  remove: (id: string) => call<boolean>('delete', { id }),
  /** Without a path, opens the file picker; `multiple: false` where only one image is used. */
  importImages: (id: string, path?: string, multiple = true) => call<Asset[]>('import', path ? { id, path } : { id, multiple }),
  saveMask: (id: string, bytes: Uint8Array) => call<Asset>('mask', { id, bytes }),
  submit: (id: string, draft: Draft, samples: number) => call<Run[]>('submit', { id, draft, samples }),
  cancel: (id: string, runId: string) => call<void>('cancel', { id, runId }),
  resume: (id: string) => call<void>('resume', { id }),
  exportImage: (id: string, runId: string, sidecar: boolean, includeInputs: boolean) => call<ExportResult | undefined>('export', { id, runId, sidecar, includeInputs }),
  collection: () => call<boolean>('collection'),
  preferences: (value: Preferences) => call<Overview>('preferences', value),
  pickPath: (file = false) => call<string | undefined>('pickPath', { file }),
  pickComponent: (directory: string) => call<string | undefined>('pickComponent', { directory }),
  engines: (modelId: string) => call<Engines>('engines', { modelId }),
  installPython: (modelId: string) => call<unknown>('installPython', { modelId }),
  installNative: (modelId: string) => call<unknown>('installNative', { modelId }),
  download: (modelId: string) => call<{ status?: string } | undefined>('prepare', { modelId, download: true }),
  register: (modelId: string, directory: string | undefined, checkpoint: string | undefined, components: Components) => call<{ status?: string } | undefined>('prepare', { modelId, directory, checkpoint, components }),
  verify: (modelId: string) => call<{ status?: string }>('verify', { modelId }),
  removeManaged: (modelId: string, name: string) => call<{ status?: string } | undefined>('removeManaged', { modelId, name }),
  inventory: () => call<Inventory>('models'),
  cancelManaged: () => call<void>('cancelManaged'),
  droppedFile: (file: File) => window.picpatch.droppedFile(file),
  onCommand: (listener: (id: string) => void) => window.picpatch.onCommand(listener),
  onChange: (listener: () => void) => window.picpatch.onChange(listener),
  /** Stage and progress of the active run only. */
  onQueue: (listener: (state: QueueState) => void) => window.picpatch.onQueue(state => listener(state as QueueState)),
  onRequest: (listener: (request: RendererRequest) => Promise<unknown>) => window.picpatch.onRequest(listener),
};

/** Session images (imported inputs and results) are served by main under this scheme. */
/** `thumbnail` asks for a small preview instead of the full image. */
export const imageUrl = (sessionId: string, key: string, thumbnail = false) => `picpatch-image://${sessionId}/${key}${thumbnail ? `?size=${thumbnailSize}` : ''}`;
