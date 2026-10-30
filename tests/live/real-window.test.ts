/**
 * The real windows in Electron, hidden, over a throwaway data folder: the Records window with 10,000 records while
 * three more arrive each second, and paint mask's undo on Chromium's canvas. The checks are the app's own smoke
 * modes (`--smoke-records`, `--smoke-mask` in `src/main/qualification.ts`); this builds the app, runs each and reads
 * its verdict line. They need the built app and a display, so they run in the full gate.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { beforeAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const [code] = (await once(child, 'exit')) as [number | null];
  expect(code, output).toBe(0);
  return output;
}

/** Runs the built app in one smoke mode over a new data folder and returns its verdict. */
async function verdict(mode: string, label: string): Promise<{ pass: boolean }> {
  const home = await mkdtemp(join(tmpdir(), 'picpatch-real-window-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PICPATCH_DATA_DIR: home }; delete env.ELECTRON_RUN_AS_NODE;
    const output = await run(electron as unknown as string, ['.', mode], env);
    const line = output.split('\n').find(text => text.startsWith(`${label} `));
    expect(line, output).toBeDefined();
    process.stdout.write(`${line}\n`);
    return JSON.parse(line!.slice(label.length + 1));
  } finally { await rm(home, { recursive: true, force: true }); }
}

beforeAll(async () => { await run(join(root, 'node_modules/.bin/electron-vite'), ['build']); });

it('pages, updates live and holds still over 10,000 records in the real Records window', async () => {
  expect(await verdict('--smoke-records', 'RECORDS-CHECK')).toMatchObject({ pass: true });
});

it('undoes and redoes painting, erasing and Clear on the real canvas, pixel for pixel', async () => {
  expect(await verdict('--smoke-mask', 'MASK-CHECK')).toMatchObject({ pass: true });
});
