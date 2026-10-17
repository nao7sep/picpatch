"""Qwen reference ordering, operation contracts and shared settlement."""
from threading import Event
import pytest
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.errors import InvalidEditInput, Cancelled
from mflux_double import fake_runtime


@pytest.fixture(params=['qwen-image-edit-2511', 'qwen-image-2.1'])
def family(request, tmp_path):
    variant = request.param
    unified = variant != 'qwen-image-edit-2511'
    adapter = create_adapter({'variant': variant, 'directory': str(tmp_path),
                              'manifest': {'model': variant, 'source': {'revision': 'a' * 40}}})
    return (adapter, 'mflux.models.qwen21.variants.edit.qwen_image_21_edit' if unified else
            'mflux.models.qwen.variants.edit.qwen_image_edit',
            'QwenImage21Edit' if unified else 'QwenImageEdit',
            'qwen_image_21' if unified else 'qwen_image_edit_2511')


def request_for(family, tmp_path):
    return {'model': family[0].config['variant'], 'instruction': 'A blue bowl.', 'seed': 0,
            'sourceImage': '/source.png', 'size': {'width': 64, 'height': 32},
            'references': [{'id': 'object', 'role': 'object', 'images': ['/a.png', '/b.png']},
                           {'id': 'style', 'role': 'style', 'images': ['/c.png']}],
            'outputPath': str(tmp_path / 'output.png')}


def test_order_defaults_and_full_precision_loading(monkeypatch, family, tmp_path):
    calls, config = fake_runtime(monkeypatch, family)
    adapter = family[0]
    request = request_for(family, tmp_path)
    result = adapter.edit(request, Event(), lambda event: None)
    assert calls[0] == ('load', {'model_config': config, 'model_path': str(tmp_path)})
    args = calls[1][1]
    assert args['image_paths'] == ['/source.png', '/a.png', '/b.png', '/c.png']
    assert args['prompt'] == ('Image 1 is the source image to edit.\n'
                              'Images 2, 3 are object references for group "object".\n'
                              'Images 4 are style references for group "style".\n\nA blue bowl.')
    expected_steps = {'qwen-image-edit-2511': 20, 'qwen-image-2.1': 40}
    assert args['num_inference_steps'] == expected_steps[adapter.config['variant']]
    assert args['guidance'] == (1.0 if adapter.capabilities['textToImage'] else 4.0)
    assert result['references'] == request['references'] and result['seed'] == 0
    assert calls[-2:] == [('sync',), ('clear',)]
    assert 'inputGeometry' not in adapter.capabilities
    assert adapter.capabilities['maskMode'] == ('latent-composite' if adapter.config['variant'] == 'qwen-image-2.1' else 'none')


def test_reference_only_edit(monkeypatch, family, tmp_path):
    calls, _ = fake_runtime(monkeypatch, family)
    request = request_for(family, tmp_path)
    del request['sourceImage']
    family[0].edit(request, Event(), lambda event: None)
    assert calls[1][1]['image_paths'] == ['/a.png', '/b.png', '/c.png']


@pytest.mark.parametrize('change', [{'maskImage': '/mask.png', 'sourceImage': None}, {'sourceImage': None, 'references': []},
                                    {'size': {'width': 17, 'height': 32}}])
def test_invalid_edit_never_loads(monkeypatch, family, tmp_path, change):
    calls, _ = fake_runtime(monkeypatch, family)
    with pytest.raises(InvalidEditInput):
        family[0].edit({**request_for(family, tmp_path), **change}, Event(), lambda event: None)
    assert calls == []


def test_generation_and_readiness_use_the_correct_pipeline(monkeypatch, family, tmp_path):
    calls, _ = fake_runtime(monkeypatch, family)
    request = {'model': family[0].config['variant'], 'prompt': 'A bowl.', 'seed': 0,
               'size': {'width': 64, 'height': 32}, 'outputPath': str(tmp_path / 'output.png')}
    if family[0].capabilities['textToImage']:
        family[0].generate(request, Event(), lambda event: None)
        assert calls[1][1]['prompt'] == 'A bowl.'
        assert 'image_paths' not in calls[1][1]
    else:
        with pytest.raises(InvalidEditInput):
            family[0].generate(request, Event(), lambda event: None)
        assert calls == []
    assert family[0].inspect_runtime('imports')['status'] == 'imports-ready'
    assert family[0].inspect_runtime('load')['status'] == 'load-ready'


def test_cancellation_settles_before_publication(monkeypatch, family, tmp_path):
    cancel = Event()
    calls, _ = fake_runtime(monkeypatch, family, cancel)
    with pytest.raises(Cancelled):
        family[0].edit(request_for(family, tmp_path), cancel, lambda event: None)
    assert not (tmp_path / 'output.png').exists()
    assert calls[-2:] == [('sync',), ('clear',)]


def test_qwen21_total_count_and_geometry_before_load(monkeypatch, tmp_path):
    config = {'variant': 'qwen-image-2.1', 'directory': str(tmp_path), 'manifest': {'model': 'qwen-image-2.1'}}
    adapter = create_adapter(config)
    monkeypatch.setattr(adapter, 'load_pipeline', lambda _: pytest.fail('Must not load'))
    request = {'model': 'qwen-image-2.1', 'instruction': 'A bowl.', 'sourceImage': '/source.png',
               'references': [{'id': 'r', 'role': 'object', 'images': [f'/{i}.png' for i in range(10)]}]}
    with pytest.raises(InvalidEditInput):
        adapter.edit(request, Event(), lambda event: None)
    with pytest.raises(InvalidEditInput):
        adapter.generate({'model': 'qwen-image-2.1', 'prompt': 'A bowl.', 'size': {'width': 16, 'height': 32}}, Event(), lambda event: None)


def test_qwen21_strength_mapping_and_source_requirement(monkeypatch, tmp_path):
    adapter = create_adapter({'variant': 'qwen-image-2.1', 'directory': str(tmp_path),
                              'manifest': {'model': 'qwen-image-2.1', 'source': {'revision': 'a' * 40}}})
    family = (adapter, 'mflux.models.qwen21.variants.edit.qwen_image_21_edit', 'QwenImage21Edit', 'qwen_image_21')
    calls, _ = fake_runtime(monkeypatch, family)
    request = {**request_for(family, tmp_path), 'parameters': {'strength': 0.5}}
    result = adapter.edit(request, Event(), lambda _: None)
    assert calls[1][1]['strength'] == result['effectiveParameters']['strength'] == 0.5
    assert calls[1][1]['image_paths'][0] == '/source.png'
    calls.clear()
    with pytest.raises(InvalidEditInput):
        adapter.edit({**request, 'sourceImage': None}, Event(), lambda _: None)
    with pytest.raises(InvalidEditInput):
        adapter.generate({**request, 'prompt': 'Blue'}, Event(), lambda _: None)
    assert not calls
    assert 'strength' not in adapter.sampling({}, 'generate')[1]
