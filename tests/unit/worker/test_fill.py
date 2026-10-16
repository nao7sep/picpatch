"""Native Fill conditioning, operation admission and shared inference settlement."""
from threading import Event
import pytest
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.fill import FillAdapter
from picpatch_worker.backends.errors import InvalidEditInput, Cancelled
from mflux_double import fake_runtime


@pytest.fixture
def fill(tmp_path):
    config = {'variant': 'flux1-fill-dev', 'directory': str(tmp_path), 'quantize': 4,
              'manifest': {'model': 'fill', 'source': {'revision': 'a' * 40}}}
    return create_adapter(config), 'mflux.models.flux.variants.fill.flux_fill', 'Flux1Fill', 'dev_fill'


def request(tmp_path):
    return {'model': 'fill', 'instruction': 'A blue bowl.', 'sourceImage': '/source.png',
            'maskImage': '/mask.png', 'size': {'width': 32, 'height': 16}, 'seed': 0,
            'outputPath': str(tmp_path / 'output.png')}


def test_native_conditioning_and_no_final_compositing(monkeypatch, fill, tmp_path):
    adapter = fill[0]
    assert isinstance(adapter, FillAdapter)
    calls, config = fake_runtime(monkeypatch, fill)
    events = []
    result = adapter.edit(request(tmp_path), Event(), events.append)
    assert calls[0] == ('load', {'model_config': config, 'model_path': str(tmp_path), 'quantize': 4})
    assert calls[1] == ('generate', {'seed': 0, 'prompt': 'A blue bowl.', 'width': 32, 'height': 16,
                                  'image_path': '/source.png', 'masked_image_path': '/mask.png',
                                  'num_inference_steps': 25, 'guidance': 30.0})
    # Source paths deliberately do not exist: native output is not reopened for a composite.
    assert (tmp_path / 'output.png').read_bytes() == b'pixels'
    assert result['modelRevision'] == 'a' * 40 and result['references'] == []
    assert {event['verb'] for event in events} == {'edit'}
    assert calls[-2:] == [('sync',), ('clear',)]
    assert adapter.capabilities['maskMode'] == 'native'
    assert adapter.capabilities['maskRequired'] and not adapter.capabilities['textToImage']


@pytest.mark.parametrize('change', [{'sourceImage': None}, {'maskImage': None},
                                    {'references': [{'id': 'r', 'role': 'style', 'images': ['/r.png']}]},
                                    {'size': {'width': 17, 'height': 16}}])
def test_invalid_fill_never_loads(monkeypatch, fill, tmp_path, change):
    calls, _ = fake_runtime(monkeypatch, fill)
    with pytest.raises(InvalidEditInput):
        fill[0].edit({**request(tmp_path), **change}, Event(), lambda event: None)
    assert calls == []


def test_generation_is_rejected_and_readiness_loads_fill(monkeypatch, fill, tmp_path):
    calls, _ = fake_runtime(monkeypatch, fill)
    with pytest.raises(InvalidEditInput):
        fill[0].generate(request(tmp_path), Event(), lambda event: None)
    assert calls == []
    assert fill[0].inspect_runtime('imports')['status'] == 'imports-ready'
    assert fill[0].inspect_runtime('load')['status'] == 'load-ready'
    assert calls[-2:] == [('sync',), ('clear',)]


def test_fill_cancellation_settles_gpu_without_publication(monkeypatch, fill, tmp_path):
    cancel = Event()
    calls, _ = fake_runtime(monkeypatch, fill, cancel)
    with pytest.raises(Cancelled):
        fill[0].edit(request(tmp_path), cancel, lambda event: None)
    assert not (tmp_path / 'output.png').exists()
    assert calls[-2:] == [('sync',), ('clear',)]
