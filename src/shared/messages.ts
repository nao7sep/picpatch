import type { Message } from './i18n/index.ts';
export interface AppMessage {
  title: Message;
  detail?: Message;
  actions: { label: Message; destructive?: boolean }[];
}
export type RendererRequest = { kind: 'message'; message: AppMessage } | { kind: 'flush' } | { kind: 'closeDrafts' };
export interface RendererReply { id: number; ok: boolean; value?: unknown; message?: string }
