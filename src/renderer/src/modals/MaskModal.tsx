// Mask painting over the image being edited: brush and eraser, undo and redo, and
// Clear. The painted region is what the model may change. Done saves the mask as a
// white-on-black image; Cancel leaves the previous mask as it was.
import { useEffect, useRef, useState } from 'react';
import { fitImage, imagePoint } from '../../../shared/viewport.ts';
import { BrushIcon, EraserIcon, RedoIcon, UndoIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';
import { Modal } from './Modal.tsx';
import { api } from '../api.ts';
import { MaskWorker } from '../mask/client.ts';
import type { MaskCommand } from '../mask/editor.ts';

export function MaskModal({ source, mask, note, onClose, onDone, onAccepted, confirmDiscard, onDirty }: {
  source: string; mask: string | undefined; note: string;
  onClose: () => void; onDone: (bytes: Uint8Array | null) => Promise<string | undefined>; confirmDiscard: () => Promise<boolean>; onDirty: (dirty: boolean) => void;
  onAccepted?: (task: Promise<void>) => void;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const owner = useRef<MaskWorker | undefined>(undefined);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [brush, setBrush] = useState(48);
  const [erase, setErase] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const drawing = useRef(false);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setSize(undefined); setReady(false);
    const image = new Image();
    image.onload = () => { if (alive) setSize({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { if (alive) setFailure(t('mask.unavailable')); };
    image.src = source;
    return () => { alive = false; image.onload = image.onerror = null; };
  }, [source, t]);

  useEffect(() => {
    if (!size) return;
    let alive = true;
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    canvas.tabIndex = 0; canvas.setAttribute('aria-label', t('mask.canvas'));
    frame.current!.append(canvas);
    let worker: MaskWorker;
    try { worker = new MaskWorker(new Worker(new URL('../mask/worker.ts', import.meta.url), { type: 'module' })); }
    catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      canvas.remove(); setFailure(t('mask.unavailable'));
      void api.reportError({ message: value.message, stack: value.stack });
      return;
    }
    owner.current = worker;
    setReady(false); setHistory({ undo: false, redo: false });
    const initialize = async () => {
      let bitmap: ImageBitmap | undefined;
      if (mask) {
        // Browser image decoding stays asynchronous; only the decoded bitmap is
        // transferred. No full-resolution pixels are read on the UI thread.
        const image = new Image(); image.crossOrigin = 'anonymous';
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not load mask'));
          image.src = mask;
        });
        bitmap = await createImageBitmap(image);
      }
      if (!alive) { bitmap?.close(); return; }
      try {
        const offscreen = canvas.transferControlToOffscreen();
        await worker.run({ kind: 'init', canvas: offscreen, ...(bitmap ? { mask: bitmap } : {}) }, [offscreen, ...(bitmap ? [bitmap] : [])]);
      } catch (error) { bitmap?.close(); throw error; }
      if (alive) setReady(true);
    };
    void initialize().catch(error => {
      void api.reportError({ message: error.message, stack: error.stack });
      if (alive) setFailure(t('mask.unavailable'));
    });
    return () => {
      alive = false; drawing.current = false;
      if (owner.current === worker) owner.current = undefined;
      canvas.remove();
      // A reply, including an asynchronous encode reply, proves settlement.
      void worker.close();
    };
  }, [size, mask, t]);

  const command = (value: MaskCommand) => {
    if (!ready || savingRef.current || !owner.current) return;
    const worker = owner.current;
    void worker.run(value).then(result => {
      if (owner.current === worker) setHistory({ undo: result.undo, redo: result.redo });
    }).catch(error => {
      if (owner.current === worker) { setFailure(t('mask.unavailable')); setReady(false); }
      void api.reportError({ message: error.message, stack: error.stack });
    });
  };
  const step = (kind: 'undo' | 'redo') => {
    if (!history[kind] || savingRef.current) return;
    command({ kind }); setDirty(true);
  };
  const stroke = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    command({ kind: 'stroke', point: imagePoint({ x: event.clientX, y: event.clientY }, bounds, size!), width: brush * size!.width / bounds.width, erase });
    setDirty(true);
  };
  const close = async () => { if (savingRef.current) return; if (!dirty || await confirmDiscard()) onClose(); };
  const done = () => {
    if (!ready || savingRef.current || !owner.current) return;
    if (!dirty) { onClose(); return; }
    savingRef.current = true; setSaving(true); setFailure(undefined);
    const worker = owner.current;
    const accepted = Promise.withResolvers<void>();
    // Quit must see the accepted save before encoding begins, including the
    // interval before any bytes have reached the main process's save owner.
    onAccepted?.(accepted.promise);
    let saveProblem: string | undefined;
    const presented = accepted.promise.catch(error => {
      if (saveProblem) setFailure(saveProblem);
      else {
        const value = error instanceof Error ? error : new Error(String(error));
        void api.reportError({ message: value.message, stack: value.stack });
        setFailure(t('ui.could_not_encode_mask'));
      }
    }).finally(() => { savingRef.current = false; setSaving(false); });
    void (async () => {
      const result = await worker.run({ kind: 'encode' });
      saveProblem = await onDone(result.bytes!);
      if (saveProblem) throw new Error(saveProblem);
    })().then(accepted.resolve, accepted.reject);
    return presented;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isComposing(event.nativeEvent) || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
    if ((event.target as HTMLElement).closest('input[type=text],textarea')) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) step(event.shiftKey ? 'redo' : 'undo');
  };

  return (
    <Modal title={t('mask.title')} large onClose={() => void close()} guarded closeDisabled={saving} footer={<>
      <span className="foot-note">{note}</span>
      <span className="spacer" />
      <button type="button" className="button" disabled={saving} onClick={() => void close()}>{t('ui.cancel')}</button>
      <button type="button" className="button primary" disabled={!ready || saving} onClick={() => void done()}>{t('ui.done')}</button>
    </>}>
      <div className="mask-editor" onKeyDown={onKeyDown}>
        <div className="mask-tools">
          <div className="segmented" role="radiogroup" aria-label={t('mask.tool')}>
            <label className={!erase ? 'on' : undefined}><input type="radio" name="mask-tool" checked={!erase} onChange={() => setErase(false)} /><BrushIcon /><span>{t('mask.paint')}</span></label>
            <label className={erase ? 'on' : undefined}><input type="radio" name="mask-tool" checked={erase} onChange={() => setErase(true)} /><EraserIcon /><span>{t('mask.erase')}</span></label>
          </div>
          <label className="mask-brush"><span>{t('ui.brush_size')}</span><input type="range" min={4} max={200} value={brush} onChange={event => setBrush(Number(event.target.value))} /></label>
          <button type="button" className="icon-button" disabled={!ready || saving || !history.undo} onClick={() => step('undo')} aria-label={t('ui.undo_stroke')} title={t('ui.undo_stroke')}><UndoIcon /></button>
          <button type="button" className="icon-button" disabled={!ready || saving || !history.redo} onClick={() => step('redo')} aria-label={t('ui.redo_stroke')} title={t('ui.redo_stroke')}><RedoIcon /></button>
          <button type="button" className="button compact" disabled={!ready || saving} onClick={() => { command({ kind: 'clear' }); setDirty(true); }}>{t('ui.clear_mask')}</button>
        </div>
        <div className="mask-stage" ref={stage}>
          {size ? (
            <div className="mask-frame" ref={frame} style={fitImage(size, stageSize)}
              onPointerDown={event => {
                if (event.button !== 0 || !ready || savingRef.current) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                command({ kind: 'begin' }); drawing.current = true; stroke(event);
              }}
              onPointerMove={event => { if (drawing.current) stroke(event); }}
              onPointerUp={() => { if (drawing.current) command({ kind: 'end' }); drawing.current = false; }}
              onPointerCancel={() => { if (drawing.current) command({ kind: 'end' }); drawing.current = false; }}
            >
              <img src={source} alt="" draggable={false} />
            </div>
          ) : <p className="mask-problem">{failure ?? t('mask.loading')}</p>}
        </div>
        {failure && size && <p className="field-error" role="alert">{failure}</p>}
      </div>
    </Modal>
  );
}
