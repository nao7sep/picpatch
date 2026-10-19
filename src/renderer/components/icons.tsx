// PicPatch's drawn marks: a 20-unit grid, 1.5 strokes, round joins, art centred
// in its box (so the icon class aligns it to the middle of the text beside it).
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M10 4.5v11M4.5 10h11" /></Svg>;
export const MenuIcon = (p: IconProps) => <Svg {...p}><path d="M4 6h12M4 10h12M4 14h12" /></Svg>;
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" /></Svg>;
export const ChevronDownIcon = (p: IconProps) => <Svg {...p}><path d="m6 8 4 4 4-4" /></Svg>;
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="m12 5-5 5 5 5" /></Svg>;
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="m8 5 5 5-5 5" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="m4.5 10.5 3.5 3.5 7.5-8" /></Svg>;
export const PencilIcon = (p: IconProps) => <Svg {...p}><path d="m12.6 4.4 3 3L7.4 15.6l-3.6.6.6-3.6Z" /></Svg>;
export const SendIcon = (p: IconProps) => <Svg {...p}><path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" /></Svg>;
export const StopIcon = (p: IconProps) => <Svg {...p}><rect x="5.5" y="5.5" width="9" height="9" rx="1.6" fill="currentColor" stroke="none" /></Svg>;
export const ResumeIcon = (p: IconProps) => <Svg {...p}><path d="M6.5 4.8v10.4L15 10Z" /></Svg>;
/** Image options: three sliders. */
export const SlidersIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 5.5h5M13 5.5h3M4 10h2M10 10h6M4 14.5h7M15 14.5h1" /><circle cx="11" cy="5.5" r="1.8" /><circle cx="8" cy="10" r="1.8" /><circle cx="13" cy="14.5" r="1.8" /></Svg>
);
/** Attach: an image with a plus in its corner. */
export const AttachIcon = (p: IconProps) => (
  <Svg {...p}><path d="M10.5 4H5.2A1.7 1.7 0 0 0 3.5 5.7v8.6A1.7 1.7 0 0 0 5.2 16h9.6a1.7 1.7 0 0 0 1.7-1.7V10" /><path d="m3.8 13.6 3.6-3.4 2.6 2.4 1.9-1.6 4.2 3.4" /><path d="M15 2.8v5M12.5 5.3h5" /></Svg>
);
export const ImageIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4" width="14" height="12" rx="1.8" /><path d="m3.5 13.5 3.8-3.6 2.8 2.6 2.2-1.9 4.2 3.4" /><circle cx="13" cy="7.6" r="1.2" /></Svg>
);
/** A reference group: stacked prints. */
export const StackIcon = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="6" width="11" height="10" rx="1.6" /><path d="M14 6V4.8A1.3 1.3 0 0 0 12.7 3.5H4.8A1.3 1.3 0 0 0 3.5 4.8v7.4A1.3 1.3 0 0 0 4.8 13.5H6" /></Svg>
);
export const BrushIcon = (p: IconProps) => (
  <Svg {...p}><path d="M15.5 3.5l-7 7M10 12l-2-2" /><path d="M8 10c-2 0-3.5 1.2-3.5 3.2 0 1.2-.6 2-1.5 2.3 1 .7 2.2 1 3.4 1 2.3 0 3.6-1.7 3.6-3.5" /></Svg>
);
export const EraserIcon = (p: IconProps) => (
  <Svg {...p}><path d="m8.2 16 7.3-7.3a1.6 1.6 0 0 0 0-2.3l-2.4-2.4a1.6 1.6 0 0 0-2.3 0L3.5 11.3a1.6 1.6 0 0 0 0 2.3L5.9 16Z" /><path d="M8.2 16H16.5M7 8l5 5" /></Svg>
);
export const UndoIcon = (p: IconProps) => <Svg {...p}><path d="M7.5 5 4 8.5 7.5 12" /><path d="M4.5 8.5h7a4 4 0 0 1 0 8H9" /></Svg>;
export const RedoIcon = (p: IconProps) => <Svg {...p}><path d="M12.5 5 16 8.5 12.5 12" /><path d="M15.5 8.5h-7a4 4 0 0 0 0 8H11" /></Svg>;
export const ExpandIcon = (p: IconProps) => <Svg {...p}><path d="M11.5 4h4.5v4.5M8.5 16H4v-4.5M16 4l-5 5M4 16l5-5" /></Svg>;
export const SaveIcon = (p: IconProps) => (
  <Svg {...p}><path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 14.5v1A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-1" /></Svg>
);
/** Edit this: a target over the print. */
export const TargetIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="10" cy="10" r="5.5" /><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" /><path d="M10 2.5v2.5M10 15v2.5M2.5 10H5M15 10h2.5" /></Svg>
);
/** Reuse settings: the command goes back down into the composer. */
export const ReuseIcon = (p: IconProps) => <Svg {...p}><path d="M5 4v5.5A2.5 2.5 0 0 0 7.5 12H15M11.5 8.5 15 12l-3.5 3.5" /></Svg>;
export const CompareIcon = (p: IconProps) => <Svg {...p}><rect x="3" y="4" width="14" height="12" rx="1.8" /><path d="M10 2.5v15" /><path d="m6 8.5-1.5 1.5L6 11.5M14 8.5l1.5 1.5-1.5 1.5" /></Svg>;
export const CanvasIcon = (p: IconProps) => <Svg {...p}><rect x="6.5" y="6.5" width="7" height="7" rx="1" /><path d="M3.5 6V4.5a1 1 0 0 1 1-1H6M14 3.5h1.5a1 1 0 0 1 1 1V6M16.5 14v1.5a1 1 0 0 1-1 1H14M6 16.5H4.5a1 1 0 0 1-1-1V14" /></Svg>;
export const TrashIcon = (p: IconProps) => <Svg {...p}><path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.6A1.5 1.5 0 0 0 7.8 17h4.4a1.5 1.5 0 0 0 1.5-1.4l.8-9.6" /></Svg>;
export const ExternalIcon = (p: IconProps) => <Svg {...p}><path d="M11 4h5v5M16 4l-7 7" /><path d="M14 11.5v3A1.5 1.5 0 0 1 12.5 16h-7A1.5 1.5 0 0 1 4 14.5v-7A1.5 1.5 0 0 1 5.5 6h3" /></Svg>;
export const FolderIcon = (p: IconProps) => <Svg {...p}><path d="M3 6.2A1.7 1.7 0 0 1 4.7 4.5h3l1.6 1.8h6A1.7 1.7 0 0 1 17 8v6.3a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 14.3Z" /></Svg>;
/** The shape glyph of a width and height: a frame of that aspect. */
export function ShapeIcon({ width, height, ...p }: IconProps & { width: number; height: number }) {
  const scale = 12 / Math.max(width, height, 1);
  const w = Math.max(5, width * scale), h = Math.max(5, height * scale);
  return <Svg {...p}><rect x={10 - w / 2} y={10 - h / 2} width={w} height={h} rx="1.4" /></Svg>;
}
