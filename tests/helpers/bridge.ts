// A fake preload bridge for renderer tests: actions resolve from handlers, pushes are
// captured so tests can send native commands, change notices and main's requests.
import { vi } from 'vitest';
import type { Bridge } from '../../src/shared/bridge.ts';
import type { RendererRequest } from '../../src/shared/messages.ts';
import type { Draft, Run, Session } from '../../src/app/types.ts';
import { initialDraft } from '../../src/app/types.ts';

export const capabilities = {
  model: 'flux2-klein-4b-4bit', instructionEditing: true, textToImage: true, referenceRoles: ['subject', 'object', 'style', 'background'],
  referenceConditioning: 'ordered-images-with-role-prompt', maskMode: 'composite', outpainting: true,
  parameters: { steps: { default: 4, minimum: 1, integer: true } },
};
export const models = [
  { id: 'flux2-klein-4b-4bit', variant: 'flux2-klein-4b', family: 'flux2-klein', acquisition: 'pinned', capabilities, runtime: { name: 'mflux' }, downloadBytes: 4.6e9 },
  { id: 'sd15', variant: 'sd15', family: 'sd15', acquisition: 'external', capabilities: { ...capabilities, model: 'sd15', referenceRoles: [], instructionEditing: false }, runtime: { name: 'stable-diffusion.cpp' } },
];

export function session(patch: Partial<Session> = {}): Session {
  return { version: 1, id: '11111111-1111-4111-8111-111111111111', name: 'Mountain poster', created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z', draft: initialDraft(), assets: [], runs: [], ...patch };
}
export function run(id: string, patch: Partial<Run> = {}): Run {
  return { id, modelId: 'flux2-klein-4b-4bit', seed: 7, draft: { ...initialDraft(), text: `Command ${id}` }, status: 'completed', created: `2026-10-01T00:00:0${id.length % 10}.000Z`, output: `outputs/${id}.png`, ...patch };
}

export function fakeBridge(initial: Session = session(), overrides: Record<string, (payload: any) => unknown> = {}) {
  let current = structuredClone(initial);
  const commands: ((id: string) => void)[] = [], changes: (() => void)[] = [];
  let request: ((request: RendererRequest) => Promise<unknown>) | undefined;
  const handlers: Record<string, (payload: any) => unknown> = {
    locale: () => ({ language: 'en', format: 'en', systemLanguage: 'en' }),
    paneState: (payload: any) => payload?.railWidth === undefined ? { railWidth: 264, optionsPane: false } : undefined,
    modelReadiness: () => ({ 'flux2-klein-4b-4bit': 'ready', sd15: 'missing' }),
    overview: () => ({ sessions: [{ id: current.id, name: current.name, updated: current.updated, results: current.runs.filter(r => r.output).length }], failures: [], models, queue: { paused: false }, settings: { version: 1, profile: { version: 1 }, registrations: {} }, locations: { engineDirectory: '/e', modelsDirectory: '/m', sessionsDirectory: '/s' }, resourcesBusy: false, locale: { language: 'en', format: 'en', systemLanguage: 'en' }, systemDark: false }),
    get: () => structuredClone(current),
    draft: ({ draft }: { draft: Draft }) => { current = { ...current, draft }; return structuredClone(current); },
    create: () => { throw new Error('unexpected create'); },
    ...overrides,
  };
  const call = vi.fn(async (action: string, payload?: unknown) => {
    const handler = handlers[action];
    return handler ? handler(payload) : undefined;
  });
  const bridge: Bridge = {
    call,
    onCommand: listener => { commands.push(listener); return () => {}; },
    onChange: listener => { changes.push(listener); return () => {}; },
    onRequest: listener => { request = listener; },
    droppedFile: file => `/drops/${file.name}`,
  };
  return {
    bridge, call, handlers,
    get session() { return current; }, set session(value: Session) { current = value; },
    command: (id: string) => commands.forEach(listener => listener(id)),
    change: () => changes.forEach(listener => listener()),
    request: (value: RendererRequest) => request!(value),
    calls: (action: string) => call.mock.calls.filter(([name]) => name === action).map(([, payload]) => payload),
  };
}
