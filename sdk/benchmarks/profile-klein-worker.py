"""Benchmark-only worker launcher for the pinned MFLUX Klein implementation.

Invoke with the prepared interpreter, a report JSONL path, then the worker's
protocol arguments (--protocol-dir ...). This is a standalone benchmark entry,
not a public client runtime override. Never use it for ordinary work:
it synchronizes GPU work and materializes lazy outputs at measurement boundaries.
Reports contain stage durations only, never prompts or file paths.
"""
import functools
import json
import inspect
import os
from pathlib import Path
import runpy
import sys
import time

report, *arguments = sys.argv[1:]
if arguments[:1] != ['--protocol-dir']:
    raise SystemExit('Expected report path followed by --protocol-dir and an absolute schema directory.')
root = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(root / 'runtimes' / name / 'src') for name in ('common', 'mflux')]
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
# Refuse to overwrite an existing measurement.
output = Path(report).open('x')
import mlx.core as mx
from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
from mflux.models.flux2.model.flux2_vae.vae import Flux2VAE
from picpatch_worker.backends.runtime import MfluxAdapter


def materialize(value):
    if isinstance(value, mx.array):
        mx.eval(value)
    elif isinstance(value, (list, tuple)):
        for item in value:
            materialize(item)


def timed(stage, function):
    @functools.wraps(function)
    def invoke(*args, **kwargs):
        mx.synchronize()
        started = time.perf_counter()
        result = function(*args, **kwargs)
        materialize(result)
        mx.synchronize()
        output.write(json.dumps({'stage': stage, 'seconds': time.perf_counter() - started}) + '\n')
        output.flush()
        return result
    return invoke


MfluxAdapter.load_pipeline = timed('load', MfluxAdapter.load_pipeline)
for pipeline in (Flux2Klein, Flux2KleinEdit):
    pipeline._encode_prompt_pair = timed('text-encode', pipeline._encode_prompt_pair)
    for name in ('_predict', '_cached_predict'):
        if not hasattr(pipeline, name):
            continue
        original = getattr(pipeline, name)
        def factory(*args, original=original, **kwargs):
            return timed('denoise-step', original(*args, **kwargs))
        setattr(pipeline, name, staticmethod(factory) if isinstance(inspect.getattr_static(pipeline, name), staticmethod) else factory)
Flux2VAE.encode = timed('vae-encode', Flux2VAE.encode)
Flux2VAE.decode_packed_latents = timed('vae-decode', Flux2VAE.decode_packed_latents)
sys.argv = ['picpatch_worker', *arguments]
try:
    runpy.run_module('picpatch_worker', run_name='__main__')
finally:
    output.close()
