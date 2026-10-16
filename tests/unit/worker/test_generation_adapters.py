"""Actual adapter mapping with only the outbound inference package substituted."""
from threading import Event

import pytest
from picpatch_worker.backends import create_adapter
from mflux_double import fake_runtime
from picpatch_worker.backends.errors import InvalidEditInput, Cancelled

FAMILIES = [
    ('z-image-turbo', 'mflux.models.z_image.variants.z_image', 'ZImage', 'z_image_turbo'),
    ('flux1-dev', 'mflux.models.flux.variants.txt2img.flux', 'Flux1', 'dev'),
    ('flux1-krea-dev', 'mflux.models.flux.variants.txt2img.flux', 'Flux1', 'krea_dev'),
    ('flux1-schnell', 'mflux.models.flux.variants.txt2img.flux', 'Flux1', 'schnell'),
]


@pytest.fixture(params=FAMILIES, ids=lambda item: item[0])
def family(request, tmp_path):
    adapter, module, name, config_method = request.param
    config = {'variant': adapter, 'directory': str(tmp_path), 'quantize': 4,
              'manifest': {'model': 'external', 'source': {'revision': 'a' * 40}}}
    return create_adapter(config), module, name, config_method




def request_for(tmp_path):
    return {'model': 'external', 'prompt': 'A blue bowl.', 'size': {'width': 32, 'height': 16},
            'seed': 0, 'outputPath': str(tmp_path / 'output.png')}


def test_local_loading_generation_and_provenance(monkeypatch, family, tmp_path):
    adapter = family[0]
    calls, config = fake_runtime(monkeypatch, family)
    events = []
    result = adapter.generate(request_for(tmp_path), Event(), events.append)
    assert calls[0] == ('load', {'model_config': config, 'model_path': str(tmp_path), 'quantize': 4})
    expected = {'prompt': 'A blue bowl.', 'seed': 0, 'width': 32, 'height': 16}
    if adapter.config['variant'] in {'flux1-dev', 'flux1-krea-dev'}:
        expected.update(num_inference_steps=25, guidance=3.5)
    assert calls[1] == ('generate', expected)
    assert result['references'] == [] and result['modelRevision'] == 'a' * 40
    assert result['runtime'] == {'name': 'mflux', 'version': '0.22.0'}
    assert {event['verb'] for event in events} == {'generate'}
    assert calls[-2:] == [('sync',), ('clear',)]
    assert adapter.capabilities['textToImage'] and not adapter.capabilities['instructionEditing']
    assert adapter.capabilities['maskMode'] == 'none' and adapter.capabilities['referenceRoles'] == []


def test_edits_and_invalid_sizes_never_load(monkeypatch, family, tmp_path):
    adapter = family[0]
    calls, _ = fake_runtime(monkeypatch, family)
    with pytest.raises(InvalidEditInput):
        adapter.edit({'sourceImage': '/source.png'}, Event(), lambda event: None)
    with pytest.raises(InvalidEditInput):
        adapter.generate({**request_for(tmp_path), 'size': {'width': 17, 'height': 16}}, Event(), lambda event: None)
    assert calls == []


def test_cancel_releases_gpu_and_does_not_save(monkeypatch, family, tmp_path):
    cancel = Event()
    calls, _ = fake_runtime(monkeypatch, family, cancel)
    with pytest.raises(Cancelled):
        family[0].generate(request_for(tmp_path), cancel, lambda event: None)
    assert not (tmp_path / 'output.png').exists()
    assert calls[-2:] == [('sync',), ('clear',)]


def test_readiness_loads_selected_family_and_releases(monkeypatch, family):
    calls, _ = fake_runtime(monkeypatch, family)
    assert family[0].inspect_runtime('imports')['status'] == 'imports-ready'
    assert calls == []
    assert family[0].inspect_runtime('load')['status'] == 'load-ready'
    assert calls[-2:] == [('sync',), ('clear',)]
