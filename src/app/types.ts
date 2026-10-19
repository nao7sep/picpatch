import type { ArtifactRecord, SamplingParameters, ReferenceGroup } from 'picpatchsdk/types';
export interface ReferenceDraft extends Omit<ReferenceGroup, 'images'> { images: string[] }
export interface Draft {
  mode: 'generate' | 'edit'; text: string; modelIds: string[]; width: number; height: number;
  seed?: number; parameters: SamplingParameters; source?: string; references: ReferenceDraft[];
  control?: { image: string; kind: 'canny'; strength?: number };
  mask?: string; outpaint?: { width: number; height: number; left: number; top: number };
}
export interface Asset { id: string; name: string; file: string; bytes: number; sha256: string }
export interface Run {
  id: string; modelId: string; seed: number; draft: Draft; parent?: string;
  status: 'queued' | 'running' | 'completed' | 'refused' | 'failed' | 'cancelled' | 'interrupted';
  created: string; started?: string; ended?: string; output?: string; record?: ArtifactRecord;
  notices?: string[];
  issue?: { code: string; message: string; effect: 'none' | 'unknown' };
}
export interface Session {
  version: 1; id: string; name: string; created: string; updated: string;
  draft: Draft; assets: Asset[]; runs: Run[];
}
export interface SessionSummary { id: string; name: string; updated: string; results: number }
export const initialDraft = (): Draft => ({ mode: 'generate', text: '', modelIds: ['flux2-klein-4b-4bit'], width: 1024, height: 1024, parameters: {}, references: [] });
