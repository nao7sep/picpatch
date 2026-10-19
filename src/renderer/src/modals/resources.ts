// Shared by Setup and Models and engines: which engine a model runs on, and which
// local files its architecture takes. The SDK remains the authority at preparation.
import type { CatalogModel, Engines } from '../api.ts';

export const native = (model: CatalogModel | undefined) => model?.runtime.name === 'stable-diffusion.cpp';
export const engineReady = (model: CatalogModel | undefined, engines: Engines | undefined) => Boolean(engines && (native(model) ? engines.native : engines.python).status === 'ready');

export type ComponentKey = 'vae' | 'clipL' | 'clipG' | 't5' | 'photoMaker' | 'ipAdapter' | 'clipVision' | 'controlNet';

/** The optional files a native model's architecture accepts beside its checkpoint. */
export function componentFields(model: CatalogModel | undefined): ComponentKey[] {
  if (!native(model)) return [];
  const variant = model!.variant;
  if (variant.startsWith('hidream-o1')) return [];
  if (variant === 'sd35-large') return ['clipL', 'clipG', 't5', 'vae'];
  if (variant === 'chroma') return ['t5', 'vae'];
  if (variant === 'chroma-radiance') return ['t5'];
  return [
    'vae',
    ...(variant.includes('photomaker') ? ['photoMaker' as const] : []),
    ...(variant.includes('ip-adapter') ? ['ipAdapter' as const, 'clipVision' as const] : []),
    ...(model!.capabilities.controlKinds?.length ? ['controlNet' as const] : []),
  ];
}

export const acceptsLoras = (model: CatalogModel | undefined) => Boolean(model?.capabilities.loraFormats?.length) && !model?.variant.startsWith('hidream-o1');
