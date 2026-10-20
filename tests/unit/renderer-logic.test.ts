import { describe, expect, it, vi } from 'vitest';
import { initialDraft, type Run, type Session } from '../../src/shared/session.ts';
import { withoutTarget } from '../../src/shared/image-command.ts';
import { commandIssues } from '../../src/renderer/src/command-issues.ts';
import { DraftWriter, DRAFT_DELAY } from '../../src/renderer/src/draft-writer.ts';
import { componentFields } from '../../src/renderer/src/modals/resources.ts';
import { commandTurns } from '../../src/renderer/src/transcript.ts';
import { models } from '../helpers/bridge.ts';

const run = (id: string, created: string, text = 'x'): Run => ({ id, modelId: 'm', seed: 1, created, status: 'completed', draft: { ...initialDraft(), text } });

describe('transcript turns', () => {
  it('groups runs from one submission and keeps later identical commands apart', () => {
    const turns = commandTurns([run('a', 't1'), run('b', 't1'), run('c', 't2'), run('d', 't2', 'other'), run('e', 't1')]);
    expect(turns.map(turn => turn.runs.map(item => item.id))).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
  });
});

describe('draft writer', () => {
  it('waits while typing, writes each snapshot in order and reports the last failure', async () => {
    vi.useFakeTimers();
    const saved: string[] = []; const report = vi.fn();
    let fail = false;
    const writer = new DraftWriter(async (_id, draft) => { if (fail) throw new Error('disk'); saved.push(draft.text); }, report);
    const draft = (text: string) => ({ ...initialDraft(), text });
    writer.later('s', draft('a')); writer.later('s', draft('ab'));
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY);
    expect(saved).toEqual(['ab']);
    const value = draft('abc'); const pending = writer.now('s', value); value.text = 'mutated later';
    await pending; expect(saved).toEqual(['ab', 'abc']);
    fail = true;
    await expect(writer.now('s', draft('x'))).rejects.toThrow('disk');
    expect(report).toHaveBeenLastCalledWith(expect.any(Error));
    fail = false; await writer.now('s', draft('y')); expect(report).toHaveBeenLastCalledWith(undefined);
    vi.useRealTimers();
  });
});

describe('command readiness', () => {
  const session = (patch: Partial<Session> = {}): Session => ({ version: 1, id: 's', name: 'n', created: '', updated: '', draft: initialDraft(), assets: [], runs: [], ...patch });
  it('explains checking, unready models, a pending target and model refusals without changing the draft', () => {
    const draft = { ...initialDraft(), text: 'go' };
    expect(commandIssues(session(), draft, models as never, undefined)).toEqual([{ kind: 'checking' }]);
    expect(commandIssues(session(), draft, models as never, { 'flux2-klein-4b-4bit': 'ready' })).toEqual([]);
    expect(commandIssues(session(), { ...draft, modelIds: ['sd15'] }, models as never, { sd15: 'missing' })[0]).toEqual({ kind: 'unready', models: ['sd15'] });
    const pending = { ...draft, mode: 'edit' as const, source: 'r1' };
    expect(commandIssues(session({ runs: [{ ...run('r1', 't'), status: 'running', output: undefined }] }), pending, models as never, { 'flux2-klein-4b-4bit': 'ready' })).toContainEqual({ kind: 'waiting' });
    expect(commandIssues(session(), { ...draft, modelIds: [] }, models as never, {})).toContainEqual({ kind: 'noModel' });
  });
  it('drops the target with its mask and expansion while keeping references', () => {
    const next = withoutTarget({ ...initialDraft(), source: 'a', mask: 'm', outpaint: { width: 1, height: 1, left: 0, top: 0 }, references: [{ id: 'g', role: 'style', images: ['b'] }] });
    expect(next).toMatchObject({ mode: 'edit', references: [{ id: 'g' }] });
    expect(next).not.toHaveProperty('source'); expect(next).not.toHaveProperty('mask'); expect(next).not.toHaveProperty('outpaint');
  });
});

describe('native component fields', () => {
  const native = (variant: string, controlKinds?: string[]) => ({ id: variant, variant, family: variant, acquisition: 'external', runtime: { name: 'stable-diffusion.cpp', engine: 'native' }, capabilities: { controlKinds } }) as never;
  it('offers only the files an architecture accepts', () => {
    expect(componentFields(native('hidream-o1'))).toEqual([]);
    expect(componentFields(native('sd35-large'))).toEqual(['clipL', 'clipG', 't5', 'vae']);
    expect(componentFields(native('chroma-radiance'))).toEqual(['t5']);
    expect(componentFields(native('sdxl-ip-adapter', ['canny']))).toEqual(['vae', 'ipAdapter', 'clipVision', 'controlNet']);
    expect(componentFields(models[0] as never)).toEqual([]);
  });
});
