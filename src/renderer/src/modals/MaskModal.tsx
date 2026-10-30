// Mask painting over the image being edited: brush and eraser, undo and redo, and
// Clear. The painted region is what the model may change. Done saves the mask as a
// white-on-black image; Cancel leaves the previous mask as it was.
import { useEffect, useRef, useState } from 'react';
import { fitImage, imagePoint } from '../../../shared/viewport.ts';
import { BrushIcon, EraserIcon, RedoIcon, UndoIcon } from '../components/icons.tsx';
import { useI18n } from '../i18n.tsx';
import { isComposing } from '../ime.ts';
import { extend, MaskHistory, pixelRect, type Rect } from './mask-history.ts';
import { Modal } from './Modal.tsx';

const PAINT = '#f2a65a';

export function MaskModal({ source, mask, note, onClose, onDone, confirmDiscard, onDirty }: {
  source: string; mask: string | undefined; note: string;
  onClose: () => void; onDone: (bytes: Uint8Array | null) => Promise<string | undefined>; confirmDiscard: () => Promise<boolean>; onDirty: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [brush, setBrush] = useState(48);
  const [erase, setErase] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const context = () => canvas.current!.getContext('2d', { willReadFrequently: true })!;
  const history = useRef(new MaskHistory<ImageData>({
    read: rect => context().getImageData(rect.x, rect.y, rect.width, rect.height),
    write: ({ rect, pixels }) => context().putImageData(pixels, rect.x, rect.y),
  })).current;
  const [, setRevision] = useState(0);
  const last = useRef<{ x: number; y: number } | undefined>(undefined);
  const drawing = useRef(false);
  /** The layer as it was when the stroke began; its changed region becomes the undo entry when the stroke ends. */
  const before = useRef<HTMLCanvasElement | undefined>(undefined);
  const bounds = useRef<Rect | undefined>(undefined);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  // Image, overlay and pointer mapping share one fit of the image inside the stage.
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);

  // Load the image's size, then any saved mask as the painted overlay (its white becomes paint).
  useEffect(() => {
    const image = new Image();
    image.onload = () => setSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => setFailure(t('mask.unavailable'));
    image.src = source;
  }, [source, t]);
  useEffect(() => {
    if (!size || !mask) return;
    const image = new Image(); image.crossOrigin = 'anonymous';
    image.onload = () => {
      const ctx = context(); ctx.drawImage(image, 0, 0, size.width, size.height);
      const pixels = ctx.getImageData(0, 0, size.width, size.height);
      for (let i = 0; i < pixels.data.length; i += 4) { const alpha = pixels.data[i]!; pixels.data[i] = 0xf2; pixels.data[i + 1] = 0xa6; pixels.data[i + 2] = 0x5a; pixels.data[i + 3] = alpha; }
      ctx.putImageData(pixels, 0, 0);
    };
    image.src = mask;
  }, [size, mask]);

  const snapshot = () => context().getImageData(0, 0, size!.width, size!.height);
  const begin = () => {
    const copy = before.current ??= document.createElement('canvas');
    copy.width = size!.width; copy.height = size!.height;
    copy.getContext('2d', { willReadFrequently: true })!.drawImage(canvas.current!, 0, 0);
    bounds.current = undefined; last.current = undefined; drawing.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const rect = bounds.current && pixelRect(bounds.current, size!);
    if (!rect) return;
    history.record({ rect, pixels: before.current!.getContext('2d', { willReadFrequently: true })!.getImageData(rect.x, rect.y, rect.width, rect.height) });
    setRevision(value => value + 1);
  };
  const clear = () => {
    history.record({ rect: { x: 0, y: 0, width: size!.width, height: size!.height }, pixels: snapshot() });
    context().clearRect(0, 0, size!.width, size!.height); setDirty(true); setRevision(value => value + 1);
  };
  const step = (from: 'undo' | 'redo') => {
    if (drawing.current || !history.step(from)) return;
    setDirty(true); setRevision(value => value + 1);
  };
  const stroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = context();
    const point = imagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), size!);
    const scale = size!.width / event.currentTarget.getBoundingClientRect().width;
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = PAINT; ctx.fillStyle = PAINT; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = brush * scale;
    ctx.beginPath(); ctx.moveTo(last.current?.x ?? point.x, last.current?.y ?? point.y); ctx.lineTo(point.x, point.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    bounds.current = extend(extend(bounds.current, last.current?.x ?? point.x, last.current?.y ?? point.y, ctx.lineWidth / 2), point.x, point.y, ctx.lineWidth / 2);
    last.current = point; setDirty(true);
  };

  const close = async () => { if (saving) return; if (!dirty || await confirmDiscard()) onClose(); };
  const done = async () => {
    if (!size || saving) return;
    if (!dirty) { onClose(); return; }
    setSaving(true); setFailure(undefined);
    const pixels = snapshot();
    let painted = false;
    const out = new ImageData(size.width, size.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const value = pixels.data[i + 3]!; if (value) painted = true;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = value; out.data[i + 3] = 255;
    }
    let bytes: Uint8Array | null = null;
    if (painted) {
      const output = document.createElement('canvas'); output.width = size.width; output.height = size.height;
      output.getContext('2d')!.putImageData(out, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'));
      if (!blob) { setFailure(t('ui.could_not_encode_mask')); setSaving(false); return; }
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    const problem = await onDone(bytes);
    setSaving(false);
    if (problem) setFailure(problem);
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
      <button type="button" className="button primary" disabled={!size || saving} onClick={() => void done()}>{t('ui.done')}</button>
    </>}>
      <div className="mask-editor" onKeyDown={onKeyDown}>
        <div className="mask-tools">
          <div className="segmented" role="radiogroup" aria-label={t('mask.tool')}>
            <label className={!erase ? 'on' : undefined}><input type="radio" name="mask-tool" checked={!erase} onChange={() => setErase(false)} /><BrushIcon /><span>{t('mask.paint')}</span></label>
            <label className={erase ? 'on' : undefined}><input type="radio" name="mask-tool" checked={erase} onChange={() => setErase(true)} /><EraserIcon /><span>{t('mask.erase')}</span></label>
          </div>
          <label className="mask-brush"><span>{t('ui.brush_size')}</span><input type="range" min={4} max={200} value={brush} onChange={event => setBrush(Number(event.target.value))} /></label>
          <button type="button" className="icon-button" disabled={!history.canUndo} onClick={() => step('undo')} aria-label={t('ui.undo_stroke')} title={t('ui.undo_stroke')}><UndoIcon /></button>
          <button type="button" className="icon-button" disabled={!history.canRedo} onClick={() => step('redo')} aria-label={t('ui.redo_stroke')} title={t('ui.redo_stroke')}><RedoIcon /></button>
          <button type="button" className="button compact" disabled={!size} onClick={clear}>{t('ui.clear_mask')}</button>
        </div>
        <div className="mask-stage" ref={stage}>
          {size ? (
            <div className="mask-frame" style={fitImage(size, stageSize)}>
              <img src={source} alt="" draggable={false} />
              <canvas
                ref={canvas} width={size.width} height={size.height} tabIndex={0} aria-label={t('mask.canvas')}
                onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); begin(); stroke(event); }}
                onPointerMove={event => { if (drawing.current) stroke(event); }}
                onPointerUp={end}
                onPointerCancel={end}
              />
            </div>
          ) : <p className="mask-problem">{failure ?? t('mask.loading')}</p>}
        </div>
        {failure && size && <p className="field-error" role="alert">{failure}</p>}
      </div>
    </Modal>
  );
}
