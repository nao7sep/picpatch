"""Shared worker protocol with the managed Diffusers environment."""
from picpatch_worker_core.entry import run as run_worker
from .glm import GlmImageAdapter


def create_adapter(config):
    if config.get('variant') == 'flux2-dev':
        from .flux2 import Flux2Adapter
        return Flux2Adapter(config)
    return GlmImageAdapter(config)


def run():
    return run_worker(adapter_factory=create_adapter)


if __name__ == '__main__':
    raise SystemExit(run())
