import type { Locale } from './i18n/index.ts';
import type { RecordsQuery, RecordsPage } from './records.ts';
export interface RecordsAppearance { locale: Locale; dark: boolean; uiFont?: string; uiZoom?: number; listWidth?: number; timeZone?: string }
export interface RecordsBridge {
  query(query: RecordsQuery): Promise<RecordsPage>;
  detail(id: number): Promise<string | null>;
  appearance(): Promise<RecordsAppearance>;
  resizeList(width: number): Promise<void>;
  close(): Promise<void>;
  onRecordsChanged(listener: () => void): () => void;
  onAppearanceChanged(listener: () => void): () => void;
}
