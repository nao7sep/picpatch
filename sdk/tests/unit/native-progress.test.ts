import { expect, it } from 'vitest';
import { stepParser } from '../../src/backends/stable-diffusion-cpp/process.ts';

it('reads sd-cli sampling steps from its redrawn progress line, and nothing else', () => {
  const steps: [number, number][] = [];
  const feed = stepParser((completed, total) => steps.push([completed, total]));
  // Model loading reports bytes, not steps; the step line is redrawn with carriage returns and may arrive split.
  feed(Buffer.from('loading tensors\r|##########| 120/120 - 512.00MB/s\n'));
  feed(Buffer.from('\r|=====>     | 1/4 - 1.50s/it\x1b[K\r|==========>| 2/'));
  feed(Buffer.from('4 - 1.42s/it\x1b[K\r|====| 4/4 - 2.10it/s\x1b[K\n'));
  feed(Buffer.from('a private prompt that mentions 9/10 - and nothing else\n'));
  expect(steps).toEqual([[1, 4], [2, 4], [4, 4]]);
});

it('keeps everything a failed native process wrote to its error stream', async () => {
  const { NativeProcess } = await import('../../src/backends/stable-diffusion-cpp/process.ts');
  const timeouts = { startupMs: 10_000, editMs: 10_000, cancellationMs: 1000, shutdownMs: 1000, terminationMs: 1000 };
  const native = new NativeProcess(process.execPath, timeouts);
  const script = "process.stderr.write('x'.repeat(10000)); process.stderr.write('\\n[ERROR] model file is truncated\\n'); process.exit(3)";
  const failure = await native.run(['-e', script], process.cwd(), 10_000).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'WORKER_EXITED', details: { diagnostic: { exitCode: 3, output: `${'x'.repeat(10000)}\n[ERROR] model file is truncated\n` } } });
});
