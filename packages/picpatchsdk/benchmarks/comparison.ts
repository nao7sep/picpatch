import { appendFile, open } from 'node:fs/promises';
import { basename } from 'node:path';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createEditor, PicPatchSdkError, type EditorOptions, type EditInput, type GenerateInput, type EditResult, type ProgressEvent } from 'picpatchsdk';

export type ComparisonOperation = { operation: 'generate'; request: Omit<GenerateInput, 'sidecar'> } |
  { operation: 'edit'; request: Omit<EditInput, 'sidecar'>; sourceFromPrevious?: boolean };
export interface ComparisonCase { id: string; options: EditorOptions; operations: ComparisonOperation[] }
export interface ComparisonRecord {
  version: 1;
  case: string;
  index: number;
  measurementIndex: number;
  operation: 'generate' | 'edit';
  outcome: 'refused' | 'completed' | 'unsupported' | 'failed' | 'cancelled' | 'untested';
  seconds: number;
  model?: string;
  modelRevision?: string;
  runtime?: EditResult['runtime'];
  seed?: number;
  parameters?: EditResult['effectiveParameters'];
  conditioning?: EditResult['conditioning'];
  loras?: EditResult['loras'];
  control?: EditResult['control'];
  image?: string;
  sidecar?: string;
  sidecarStatus?: 'saved' | 'failed';
  errorCode?: string;
  memory: 'not-measured';
  hardware: { platform: string; architecture: string; release: string; cpu: string; totalMemoryBytes: number };
}

/** Caller-owned sequential experiment, not an SDK scheduler. Records exclude prompts and directories. */
export async function compare(cases: ComparisonCase[], report: string, signal?: AbortSignal, event: (value: Record<string, unknown>) => void = () => {}): Promise<void> {
  // Refuse a collision before starting inference; settle and append each result independently.
  const file = await open(report, 'wx', 0o600); await file.close();
  const hardware = { platform: platform(), architecture: arch(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', totalMemoryBytes: totalmem() };
  let measurementIndex = 0;
  for (const entry of cases) {
    let editor: ReturnType<typeof createEditor> | undefined;
    let previous: EditResult | undefined;
    try {
      for (const [index, operation] of entry.operations.entries()) {
        const started = performance.now();
        const record: ComparisonRecord = { version: 1, case: entry.id, index, measurementIndex: measurementIndex++, operation: operation.operation, outcome: 'untested', seconds: 0, memory: 'not-measured', hardware,
          ...(entry.options.model ? { model: entry.options.model.manifest.model, modelRevision: entry.options.model.manifest.source.revision } : {}) };
        event({ kind: 'start', index: record.measurementIndex, case: entry.id, count: operation.operation === 'edit' ? operation.request.references?.reduce((sum, group) => sum + group.images.length, 0) ?? 0 : 0 });
        try {
          if (!signal?.aborted && !(operation.operation === 'edit' && operation.sourceFromPrevious && !previous)) {
            try {
              editor ??= createEditor(entry.options);
              let stage: string | undefined;
              const operationOptions = { ...(signal ? { signal } : {}), onProgress: (progress: ProgressEvent) => {
                if (stage !== progress.stage) {
                  stage = progress.stage;
                  event({ kind: 'phase', index: record.measurementIndex, stage, elapsedSeconds: (performance.now() - started) / 1000 });
                }
              } };
              const result = operation.operation === 'generate'
                ? await editor.generate({ ...operation.request, sidecar: {} }, operationOptions)
                : await editor.edit({ ...operation.request, ...(operation.sourceFromPrevious ? { sourceImage: previous!.image.path } : {}), sidecar: {} }, operationOptions);
                if ('status' in result) { previous = undefined; record.outcome = 'refused'; record.errorCode = result.code; continue; }
              previous = result;
              const { negativePrompt: _private, ...parameters } = result.effectiveParameters;
              Object.assign(record, { outcome: 'completed', model: result.model, modelRevision: result.modelRevision, runtime: result.runtime, seed: result.seed, parameters,
                image: basename(result.image.path), ...(result.sidecar ? { sidecarStatus: result.sidecar.status } : {}), ...(result.conditioning ? { conditioning: result.conditioning } : {}),
                ...(result.loras ? { loras: result.loras } : {}), ...(result.control ? { control: result.control } : {}),
                ...(result.sidecar?.status === 'saved' ? { sidecar: basename(result.sidecar.path) } : {}) });
            } catch (error) {
              previous = undefined;
              record.outcome = (error instanceof PicPatchSdkError && error.kind === 'cancelled') ? 'cancelled' : error instanceof PicPatchSdkError && error.code === 'UNSUPPORTED_CAPABILITY' ? 'unsupported' : 'failed';
              record.errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
              // Failed sessions may be unusable. Dispose before trying another independent operation.
              await editor?.dispose(); editor = undefined;
            }
          }
        } finally {
          record.seconds = (performance.now() - started) / 1000;
          await appendFile(report, `${JSON.stringify(record)}\n`);
          event({ kind: 'end', index: record.measurementIndex, seconds: record.seconds, outcome: record.outcome });
        }
      }
    } finally { await editor?.dispose(); }
  }
}
