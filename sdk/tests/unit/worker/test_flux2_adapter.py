"""FLUX.2 Dev configuration and ordered appearance conditioning."""
import pytest
import importlib.util
from pathlib import Path

source = Path(__file__).resolve().parents[3] / "runtimes/diffusers/src/picpatch_diffusers/flux2.py"
spec = importlib.util.spec_from_file_location("flux2_adapter", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Flux2Adapter, conditioning = module.Flux2Adapter, module.conditioning
from picpatch_worker_core.errors import InvalidEditInput


def test_source_and_references_keep_their_declared_order():
    paths, prompt = conditioning({'sourceImage': '/source.png', 'instruction': 'Compose the scene.',
        'references': [{'id': 'left', 'role': 'subject', 'images': ['/one.png', '/two.png']},
                       {'id': 'look', 'role': 'style', 'images': ['/style.png']}]})
    assert paths == ['/source.png', '/one.png', '/two.png', '/style.png']
    assert 'Images 2, 3' in prompt and 'Images 4' in prompt
    assert prompt.endswith('Compose the scene.')


@pytest.mark.parametrize('extra', [{'maskImage': '/mask.png'}, {'outpaint': {'left': 16}},
    {'control': [{'type': 'depth'}]},
    {'references': [{'id': 'face', 'role': 'subject', 'conditioning': 'identity', 'images': ['/face.png']}] }])
def test_unsupported_conditioning_is_not_silently_ignored(extra):
    with pytest.raises(InvalidEditInput):
        conditioning({'instruction': 'Edit.', 'sourceImage': '/source.png', **extra})


def test_flux2_capabilities_are_model_specific_and_detached():
    adapter = Flux2Adapter({'variant': 'flux2-dev', 'manifest': {'model': 'fixture'}})
    capabilities = adapter.capabilities
    assert capabilities['textToImage'] and capabilities['instructionEditing']
    assert capabilities['size']['widthMultiple'] == 16
    assert capabilities['parameters']['guidance']['default'] == 4
    capabilities['parameters']['guidance']['default'] = 99
    assert adapter.capabilities['parameters']['guidance']['default'] == 4
    with pytest.raises(InvalidEditInput):
        Flux2Adapter({'variant': 'flux2-dev', 'quantize': 4})


def test_small_reference_refuses_before_model_load(monkeypatch):
    import sys
    import threading
    from types import SimpleNamespace
    class SmallImage:
        size = (63, 64)
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            pass
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: True))))
    monkeypatch.setitem(sys.modules, 'PIL', SimpleNamespace(Image=SimpleNamespace(open=lambda _path: SmallImage())))
    adapter = Flux2Adapter({'variant': 'flux2-dev', 'manifest': {'model': 'fixture'}})
    loaded = []
    monkeypatch.setattr(adapter, 'load_pipeline', lambda: loaded.append(True))
    monkeypatch.setattr(adapter, 'release', lambda: None)
    with pytest.raises(InvalidEditInput, match='at least 64 pixels'):
        adapter.edit({'model': 'fixture', 'instruction': 'Edit.', 'sourceImage': '/small.png', 'outputPath': '/output.png'}, threading.Event(), lambda _event: None)
    assert loaded == []


def test_explicit_prompt_conditioning_matches_the_default():
    group = {'id': 'person', 'role': 'subject', 'images': ['/person.png']}
    request = {'instruction': 'Place the person in the scene.', 'references': [group]}
    expected = module.conditioning(request)
    group['conditioning'] = 'prompt'
    assert module.conditioning(request) == expected
    group['conditioning'] = 'appearance'
    with pytest.raises(InvalidEditInput):
        module.conditioning(request)
