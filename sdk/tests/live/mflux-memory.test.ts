import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { liveCache } from '../helpers/live-cache.ts';

it.each(['flux2-klein-base-9b', 'z-image-turbo', 'flux1-fill-dev'])('uses the installed %s memory callback to release dead model stages', async variant => {
  const config = JSON.parse(await readFile(process.env.PICPATCH_INFERENCE_CONFIG ?? liveCache('inference-config.json'), 'utf8'));
  await promisify(execFile)(config.pythonExecutable, ['-c', `
from types import SimpleNamespace
import mlx.core as mx
from picpatch_worker.backends import create_adapter
callbacks = []
encoder, transformer, vae = object(), object(), object()
pipeline = SimpleNamespace(text_encoder=encoder, t5_text_encoder=encoder, clip_text_encoder=encoder, transformer=transformer, vae=vae,
    callbacks=SimpleNamespace(register=callbacks.append))
adapter = create_adapter({'variant': '${variant}', 'manifest': {'model': 'fixture'}})
adapter.configure_pipeline(pipeline)
assert len(callbacks) == 1
callback = callbacks[0]
assert not callback.keep_transformer and not callback.keep_text_encoder
callback.call_before_loop(seed=42, prompt='A mug.', latents=mx.zeros((1,)), config=None)
assert pipeline.text_encoder is None and pipeline.transformer is transformer
assert pipeline.t5_text_encoder is None and pipeline.clip_text_encoder is None
callback.call_after_loop(seed=42, prompt='A mug.', latents=mx.zeros((1,)), config=None)
assert pipeline.transformer is None and pipeline.vae is vae
`], { timeout: 30_000, env: { ...process.env, PYTHONPATH: [fileURLToPath(new URL('../../runtimes/mflux/src', import.meta.url)), fileURLToPath(new URL('../../runtimes/common/src', import.meta.url))].join(':') } });
}, 60_000);
