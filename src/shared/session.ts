import type { ArtifactRecord, SamplingParameters, ReferenceGroup } from 'picpatchsdk/types';
import type { Message } from './i18n/index.ts';
export const controlKinds = ['canny', 'depth', 'pose'] as const;
export type ControlKind = typeof controlKinds[number];
export interface ReferenceDraft extends Omit<ReferenceGroup, 'images'> { images: string[] }
export interface Draft {
  mode: 'generate' | 'edit'; text: string; modelIds: string[]; width: number; height: number;
  seed?: number; parameters: SamplingParameters; source?: string; references: ReferenceDraft[];
  control?: { image: string; kind: ControlKind; strength?: number };
  mask?: string; outpaint?: { width: number; height: number; left: number; top: number };
}
export interface Asset { id: string; name: string; file: string; bytes: number; sha256: string }
export interface Run {
  id: string; modelId: string; seed: number; draft: Draft; parent?: string;
  status: 'queued' | 'running' | 'completed' | 'refused' | 'failed' | 'cancelled' | 'interrupted';
  created: string; started?: string; ended?: string; output?: string; record?: ArtifactRecord;
  notices?: (string | { notice?: import('./i18n/index.ts').Message; code?: string })[];
  /** Why a run was refused, failed, cancelled or interrupted; effect records uncertainty about execution. */
  issue?: { code: string; message: string; effect?: 'none' | 'unknown' };
}
export interface Session {
  version: 1; id: string; name: string; created: string; updated: string;
  draft: Draft; assets: Asset[]; runs: Run[];
}
/** cover is the latest completed result, shown as the session's picture. */
export interface SessionSummary { id: string; name: string; updated: string; results: number; cover?: string }
/** How many images may generate at once; 1 unless the user's machine has memory for several models. */
export const maxConcurrency = 8;
/** `active` lists every run executing now, in the order they started. */
export interface QueueState { active: { sessionId: string; runId: string; stage: string; startedAt: number; elapsedMs?: number; progress?: { completed: number; total: number } }[]; paused: boolean; issue?: { code?: string; message: string; notice?: Message } }
export const initialDraft = (): Draft => ({ mode: 'generate', text: '', modelIds: ['flux2-klein-4b-4bit'], width: 1024, height: 1024, parameters: {}, references: [] });
