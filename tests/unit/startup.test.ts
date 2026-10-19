// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initialDraft } from '../../src/app/types.ts';
beforeEach(async () => {
  vi.resetModules();
  document.write((await readFile('src/renderer/index.html','utf8')).replace(/<link[^>]*>/g,'').replace(/<script[\s\S]*?<\/script>/g,''));
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({clearRect:vi.fn()} as never);
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); document.body.replaceChildren(); });
it.each(['locale','overview','get'])('keeps a failed %s load behind recovery, then retries without creating a replacement session', async failing => {
  let fail = true;
  const session = {id:'session',name:'Saved',draft:initialDraft(),assets:[],runs:[]};
  const call = vi.fn(async (action: string) => {
    if (action === failing && fail) throw new Error('EACCES /private/internal SENTINEL');
    if (action === 'ready') expect(document.getElementById('appViewport')!.hidden).toBe(false);
    if (action === 'locale') return {language:'en',format:'en'};
    if (action === 'paneState') return {requestWidth:300,sidebar:false};
    if (action === 'overview') return {sessions:[session],failures:[],models:[],queue:{},settings:{profile:{}},locations:{}};
    if (action === 'get') return session;
  });
  window.picpatch = {call,onChange:()=>()=>{},onCommand:()=>()=>{},onRequest:()=>{},droppedFile:()=>''};
  await import('../../src/renderer/main.ts');
  const el = (id:string) => document.getElementById(id)!;
  await vi.waitFor(() => expect(el('startup').hidden).toBe(false));
  expect(el('appViewport').hidden).toBe(true); expect(el('startup').textContent).not.toMatch(/EACCES|private|SENTINEL/);
  expect(call).not.toHaveBeenCalledWith('ready');
  el('quitStartup').click(); expect(call).toHaveBeenCalledWith('closeWindow');
  fail = false; el('retryStartup').click();
  await vi.waitFor(() => expect(el('appViewport').hidden).toBe(false));
  expect(el('startup').hidden).toBe(true); expect(call).toHaveBeenCalledWith('ready'); expect(call).not.toHaveBeenCalledWith('create');
});
