"""Substitute only the outbound MFLUX API for adapter contract tests."""
import sys
from types import SimpleNamespace
from picpatch_worker.backends import runtime


def fake_runtime(monkeypatch, family, cancel=None):
    adapter, module, name, config_method = family
    calls = []
    model_config = object()
    class Image:
        size = (32, 16)
        def save(self, output, **kwargs):
            assert kwargs == {'format': 'PNG'}
            output.write(b'pixels')
    class Pipeline:
        def __init__(self, **kwargs):
            calls.append(('load', kwargs))
            self.callbacks = SimpleNamespace(register=lambda observer: setattr(self, 'observer', observer))
        def generate_image(self, **kwargs):
            calls.append(('generate', kwargs))
            if cancel:
                cancel.set()
            self.observer.call_in_loop(t=0, config=SimpleNamespace(num_inference_steps=4))
            return SimpleNamespace(image=Image())
    monkeypatch.setattr(runtime, 'version', lambda _: '0.22.0')
    monkeypatch.setitem(sys.modules, 'mflux.models.common.config', SimpleNamespace(
        ModelConfig=SimpleNamespace(**{config_method: lambda: model_config})))
    monkeypatch.setitem(sys.modules, module, SimpleNamespace(**{name: Pipeline}))
    core = SimpleNamespace(synchronize=lambda: calls.append(('sync',)), clear_cache=lambda: calls.append(('clear',)))
    monkeypatch.setitem(sys.modules, 'mlx', SimpleNamespace(core=core))
    monkeypatch.setitem(sys.modules, 'mlx.core', core)
    return calls, model_config
