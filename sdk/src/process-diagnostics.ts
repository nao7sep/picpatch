import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Healthy workers may emit diagnostics for their entire lifetime. Keep those bytes in an
 * owner-only OS temporary directory, with stream backpressure, rather than retaining them
 * in memory. This local transient storage has no caller cancellation scope: its writer
 * must settle and its owner must observe child closure before removing it.
 */
export function processDiagnostics(source: Readable, onError: (cause: unknown) => void): { finish: (capture: boolean) => Promise<string | undefined> } {
  let directory: string | undefined;
  let failure: unknown;
  const file = (async () => {
    directory = await mkdtemp(join(tmpdir(), 'picpatchsdk-diagnostics-'));
    return open(join(directory, 'stderr.tmp'), 'wx', 0o600);
  })();
  const report = (cause: unknown) => {
    if (failure) return;
    failure = cause;
    onError(cause);
  };
  // Initialization may fail before a first chunk arrives.
  void file.catch(report);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void file.then(handle => handle.writeFile(chunk)).then(() => callback(), cause => callback(cause));
    },
  });
  const drained = pipeline(source, sink).catch(report);
  let finished: Promise<string | undefined> | undefined;
  return { finish(capture) {
    return finished ??= (async () => {
      let output: string | undefined;
      try {
        await drained;
        const handle = await file;
        await handle.close();
        if (failure) throw failure;
        if (capture) output = (await readFile(join(directory!, 'stderr.tmp'), 'utf8')) || undefined;
      } catch (cause) { failure ??= cause; }
      try { if (directory) await rm(directory, { recursive: true }); }
      catch (cause) {
        const cleanup = output ? new Error(`Diagnostic spool cleanup failed. Captured process output:\n${output}`, { cause }) : cause;
        failure = failure ? new AggregateError([failure, cleanup], 'Diagnostic capture and cleanup failed.', { cause: cleanup }) : cleanup;
      }
      if (failure) throw failure;
      return output;
    })();
  } };
}
