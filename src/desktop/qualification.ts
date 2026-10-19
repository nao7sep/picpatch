import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import type { Application } from '../app/service.ts';
/** Explicit automated package qualification; never reached during ordinary launch. */
export async function qualifyInference(service: Application, configuration: string, uv: string): Promise<void> {
  if (!isAbsolute(configuration)) throw new Error('Qualification configuration must be absolute.');
  const config = JSON.parse(await readFile(configuration, 'utf8'));
  const version = await promisify(execFile)(uv, ['--version'], { timeout: 5000 });
  if (!version.stdout.startsWith('uv 0.13.1 ')) throw new Error('Unexpected bundled setup tool.');
  await service.preferences({ nativeExecutable: config.executable });
  await service.prepare('sd15', config.directory, config.sd15Checkpoint);
  const session = await service.sessions.create();
  const draft = { ...session.draft, modelIds: ['sd15'], text: 'A ceramic cup on a wooden table, studio photograph', width: 512, height: 512, seed: 42, parameters: { steps: 4 } };
  await service.queue.submit(session.id, draft, 1);
  await service.queue.settled();
  const result = (await service.sessions.get(session.id)).runs[0];
  if (result?.status !== 'completed' || !result.output || result.notices?.length || service.queue.state.paused) throw new Error(`Packaged inference failed: ${JSON.stringify(result?.issue ?? service.queue.state)}`);
}
