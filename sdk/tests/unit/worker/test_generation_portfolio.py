"""Generation-only families: outbound arguments, rejection and publication boundaries."""
from threading import Event

import pytest

from mflux_double import fake_runtime
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.errors import InvalidEditInput, Cancelled

FAMILIES = [
    ('ming-image-design', 'mflux.models.ming_image.variants.ming_image', 'MingImage', 'ming_image_design'),
    ('krea-2', 'mflux.models.krea2.variants.txt2img.krea2', 'Krea2', 'krea2'),
    ('krea-2-raw', 'mflux.models.krea2.variants.txt2img.krea2', 'Krea2', 'krea2_raw'),
    ('boogu-image-turbo', 'mflux.models.boogu.variants.txt2img.boogu_image', 'BooguImage', 'boogu_image_turbo'),
]


@pytest.fixture(params=FAMILIES, ids=lambda value: value[0])
def family(request, tmp_path):
    variant, module, name, method = request.param
    adapter = create_adapter({'variant': variant, 'directory': str(tmp_path), 'quantize': 4,
                              'manifest': {'model': 'local', 'source': {'revision': 'a' * 40}}})
    return adapter, module, name, method


def request_for(tmp_path):
    return {'model': 'local', 'prompt': 'A blue bowl.', 'size': {'width': 32, 'height': 16},
            'seed': 0, 'outputPath': str(tmp_path / 'image.png')}


def test_generation_arguments_and_result(monkeypatch, family, tmp_path):
    adapter = family[0]
    calls, config = fake_runtime(monkeypatch, family)
    parameters = {'steps': 7}
    if adapter.definition['family'] == 'krea2':
        parameters.update(guidance=2, negativePrompt='blur', scheduler='euler')
    result = adapter.generate({**request_for(tmp_path), 'parameters': parameters}, Event(), lambda _: None)
    expected = {'prompt': 'A blue bowl.', 'seed': 0, 'width': 32, 'height': 16, 'num_inference_steps': 7}
    if adapter.definition['family'] == 'krea2':
        expected.update(guidance=2, negative_prompt='blur', scheduler='euler')
    assert calls[0] == ('load', {'model_config': config, 'model_path': str(tmp_path), 'quantize': 4})
    assert calls[1] == ('generate', expected)
    assert result['seed'] == 0 and result['modelRevision'] == 'a' * 40
    assert result['effectiveParameters']['steps'] == 7
    assert calls[-2:] == [('sync',), ('clear',)]


def test_readiness_and_cancel_settlement(monkeypatch, family, tmp_path):
    adapter = family[0]
    calls, _ = fake_runtime(monkeypatch, family)
    assert adapter.inspect_runtime('imports')['status'] == 'imports-ready'
    assert calls == []
    assert adapter.inspect_runtime('load')['status'] == 'load-ready'
    assert calls[-2:] == [('sync',), ('clear',)]
    cancel = Event()
    calls, _ = fake_runtime(monkeypatch, family, cancel)
    with pytest.raises(Cancelled):
        adapter.generate(request_for(tmp_path), cancel, lambda _: None)
    assert not (tmp_path / 'image.png').exists()
    assert calls[-2:] == [('sync',), ('clear',)]


def test_unsupported_conditioning_never_loads(monkeypatch, family, tmp_path):
    adapter = family[0]
    calls, _ = fake_runtime(monkeypatch, family)
    with pytest.raises(InvalidEditInput):
        adapter.edit({}, Event(), lambda _: None)
    with pytest.raises(InvalidEditInput):
        adapter.generate({**request_for(tmp_path), 'parameters': {'strength': 0.5}}, Event(), lambda _: None)
    parameters = {'guidance': 2} if adapter.definition['family'] == 'boogu' else {'negativePrompt': 'blur'}
    with pytest.raises(InvalidEditInput):
        adapter.generate({**request_for(tmp_path), 'parameters': parameters}, Event(), lambda _: None)
    assert calls == []


@pytest.mark.parametrize('filename', ['turbo.safetensors', 'raw.safetensors', 'model-00001-of-00002.safetensors'])
def test_unprepared_krea_root_override_is_never_loaded(monkeypatch, tmp_path, filename):
    adapter = create_adapter({'variant': 'krea-2', 'directory': str(tmp_path),
                              'manifest': {'model': 'local', 'source': {'revision': 'a' * 40}}})
    calls, _ = fake_runtime(monkeypatch, (adapter, *FAMILIES[1][1:]))
    (tmp_path / filename).write_bytes(b'unrecorded checkpoint')
    with pytest.raises(InvalidEditInput, match='root checkpoint'):
        adapter.generate(request_for(tmp_path), Event(), lambda _: None)
    assert calls == []


def test_unsupported_loras_are_rejected_before_runtime_import(family):
    config = {**family[0].config, 'loras': [{'path': 'adapter.safetensors'}],
              'manifest': {**family[0].config['manifest'], 'components': [{'path': 'adapter.safetensors', 'role': 'weights'}]}}
    with pytest.raises(InvalidEditInput, match='does not support LoRAs'):
        create_adapter(config)
