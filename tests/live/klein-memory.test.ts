import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('uses the installed Klein memory callback to release dead model stages', async () => {
  const config = JSON.parse(await readFile(process.env.PICPATCH_INFERENCE_CONFIG ?? fileURLToPath(new URL('../../node_modules/.cache/picpatch-live/inference-config.json', import.meta.url)), 'utf8'));
  await promisify(execFile)(config.pythonExecutable, ['-c', `
from types import SimpleNamespace
import mlx.core as mx
from picpatch_worker.backends.klein import KleinAdapter
callbacks = []
encoder, transformer, vae = object(), object(), object()
pipeline = SimpleNamespace(text_encoder=encoder, transformer=transformer, vae=vae,
    callbacks=SimpleNamespace(register=callbacks.append))
adapter = KleinAdapter({'variant': 'flux2-klein-base-9b', 'manifest': {'model': 'base9'}})
adapter.configure_pipeline(pipeline)
assert len(callbacks) == 1
callback = callbacks[0]
assert not callback.keep_transformer and not callback.keep_text_encoder
callback.call_before_loop(seed=42, prompt='A mug.', latents=mx.zeros((1,)), config=None)
assert pipeline.text_encoder is None and pipeline.transformer is transformer
callback.call_after_loop(seed=42, prompt='A mug.', latents=mx.zeros((1,)), config=None)
assert pipeline.transformer is None and pipeline.vae is vae
`], { timeout: 30_000 });
}, 60_000);
