import type { Locale } from './i18n/index.ts';
import type { RecordsQuery, RecordsPage } from './records.ts';
export interface LogsAppearance { locale: Locale; dark: boolean; uiFont?: string; uiZoom?: number }
export interface LogsBridge {
  query(query: RecordsQuery): Promise<RecordsPage>;
  detail(id: number): Promise<string | null>;
  appearance(): Promise<LogsAppearance>;
  close(): Promise<void>;
  onRecordsChanged(listener: () => void): () => void;
  onAppearanceChanged(listener: () => void): () => void;
}
