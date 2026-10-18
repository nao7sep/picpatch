import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import { PicPatchSdkError } from './errors.ts';

type Context = { parent?: Context; signal: AbortSignal; writes: boolean; stalled: boolean; subject?: string; recoveryDirectory?: string };
const contexts = new AsyncLocalStorage<Context>();
export function withoutStorageScope<T>(action: () => Promise<T>): Promise<T> { return contexts.exit(action); }
/** One active invocation owns its outstanding OS calls even after its caller stops waiting. */
export function storageScope<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const parent = contexts.getStore();
  return contexts.run({ signal, writes: parent?.writes ?? false, stalled: false, ...(parent ? { parent, ...(parent.recoveryDirectory ? { recoveryDirectory: parent.recoveryDirectory } : {}) } : {}) }, action);
}
export function storageRecovery(directory: string): void { const context = contexts.getStore(); if (context) context.recoveryDirectory = directory; }
export function storageCancellation(): PicPatchSdkError | undefined { const context = contexts.getStore(); return context?.signal.aborted ? stopped(context, context.subject ?? 'storage') : undefined; }
export function storageSignal(): AbortSignal | undefined { return contexts.getStore()?.signal; }
export function storageStalled(): boolean { return contexts.getStore()?.stalled === true; }
function stopped(context: Context, subject: string): PicPatchSdkError {
  return new PicPatchSdkError('CANCELLED', 'Storage wait stopped; an outstanding OS operation may still settle.', { subject, effect: context.stalled && context.writes ? 'unknown' : 'none', details: context.recoveryDirectory ? { recoveryDirectory: context.recoveryDirectory } : {} });
}
/** Resource release is allowed after abort; new storage work is not. */
export async function storageWait<T>(start: () => Promise<T>, subject: string, writes = false, release?: (value: T) => Promise<unknown>, closing = false): Promise<T> {
  const context = contexts.getStore();
  if (!context) return start();
  if (closing && context.signal.aborted && !context.stalled) return storageScope(AbortSignal.timeout(30_000), () => storageWait(start, subject));
  if (context.signal.aborted && !closing) throw stopped(context, subject);
  context.subject = subject;
  if (writes) for (let owner: Context | undefined = context; owner; owner = owner.parent) owner.writes = true;
  const pending = start();
  let aborted = false;
  let listener: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    listener = () => { aborted = true; for (let owner: Context | undefined = context; owner; owner = owner.parent) owner.stalled = true; reject(stopped(context, subject)); };
    context.signal.addEventListener('abort', listener, { once: true });
    if (context.signal.aborted) listener();
  });
  // A late-opened handle remains ours and is closed, never handed to expired work.
  const owned = pending.then(async value => {
    if (aborted && release) { try { await release(value); } catch { /* The expired call retains unknown effect; no fallback storage work. */ } }
    return value;
  });
  try { return await Promise.race([owned, stop]); }
  finally { if (listener) context.signal.removeEventListener('abort', listener); }
}
/** Cleanup starts only after ordinary settlement; stalled operations retain private files. */
export function storageCleanup<T>(action: () => Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (context?.stalled) throw stopped(context, context.recoveryDirectory ?? 'storage');
  // Cleanup has its own finite wait and no authority over caller-owned artifacts.
  return storageScope(AbortSignal.timeout(30_000), action);
}
const mutations = new Set(['chmod', 'mkdir', 'mkdtemp', 'rename', 'link', 'rm', 'unlink', 'writeFile', 'copyFile', 'symlink']);
function method<K extends keyof typeof fs>(name: K): typeof fs[K] {
  return ((...args: unknown[]) => storageWait(() => (fs[name] as (...args: unknown[]) => Promise<unknown>)(...args), String(args[0]), mutations.has(name))) as typeof fs[K];
}
export const chmod = method('chmod'), mkdir = method('mkdir'), mkdtemp = method('mkdtemp'), rename = method('rename'), link = method('link'), rm = method('rm'), unlink = method('unlink'), writeFile = method('writeFile'), copyFile = method('copyFile'), symlink = method('symlink');
export const access = method('access'), lstat = method('lstat'), stat = method('stat'), realpath = method('realpath'), readdir = method('readdir'), readFile = method('readFile'), statfs = method('statfs');
export const open: typeof fs.open = async (...args) => {
  const path = String(args[0]);
  const flags = args[1];
  const writes = typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' && (flags & 3) !== 0;
  const handle = await storageWait(() => fs.open(...args), path, writes, file => file.close());
  return new Proxy(handle, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (key === 'createReadStream' || key === 'createWriteStream') return value.bind(target);
    return (...parameters: unknown[]) => storageWait(() => value.apply(target, parameters), path, ['write', 'writeFile', 'truncate', 'chmod'].includes(String(key)), undefined, key === 'close' || key === Symbol.asyncDispose);
  } });
};
export const opendir: typeof fs.opendir = async (...args) => {
  const path = String(args[0]);
  const directory = await storageWait(() => fs.opendir(...args), path, false, dir => dir.close());
  return new Proxy(directory, { get(target, key) {
    if (key === Symbol.asyncIterator) return async function* () {
      const iterator = target[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await storageWait(() => iterator.next(), path);
          if (next.done) return;
          yield next.value;
        }
      } finally { await storageWait(() => iterator.return!(undefined), path, false, undefined, true); }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
};
export type { FileHandle } from 'node:fs/promises';
