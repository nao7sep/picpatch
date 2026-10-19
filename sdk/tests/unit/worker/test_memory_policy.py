"""Single-image eviction must not silently enable tiling or change cache policy."""
import sys
from types import SimpleNamespace
import pytest
from picpatch_worker.backends import create_adapter


@pytest.mark.parametrize('variant', ['z-image', 'z-image-turbo', 'flux1-fill-dev'])
def test_completed_stages_are_evicted_without_changing_decode_policy(monkeypatch, variant):
    created, registered = [], []
    def saver(**kwargs):
        created.append(kwargs)
        return kwargs
    monkeypatch.setitem(sys.modules, 'mflux.callbacks.instances.memory_saver', SimpleNamespace(MemorySaver=saver))
    pipeline = SimpleNamespace(callbacks=SimpleNamespace(register=registered.append))
    create_adapter({'variant': variant, 'manifest': {'model': 'fixture'}}).configure_pipeline(pipeline)
    assert created == [{'model': pipeline, 'keep_transformer': False, 'cache_limit_bytes': None}]
    assert registered == created
