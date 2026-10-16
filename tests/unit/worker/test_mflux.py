"""Adapter contract tests substitute only the outbound model runtime; no weights needed."""
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
from picpatch_worker.backends import mflux


@pytest.fixture
def config(tmp_path):
    return {'adapter': 'mflux-flux2-klein-4b', 'directory': str(tmp_path), 'manifest': {
        'version': 1, 'model': 'local-klein', 'source': {'repository': 'local', 'revision': 'a' * 40},
        'components': [{'path': 'weight.safetensors', 'role': 'weights', 'bytes': 1, 'sha256': 'a' * 64}]}}


@pytest.fixture
def request_data(tmp_path):
    return {'model': 'local-klein', 'instruction': 'Put the people together.', 'sourceImage': '/source.png',
            'references': [{'id': 'alice', 'role': 'subject', 'images': ['/a1.png', '/a2.png']},
                           {'id': 'bob', 'role': 'subject', 'images': ['/b.png']}],
            'outputPath': str(tmp_path / 'out.png'), 'seed': 0, 'size': {'width': 512, 'height': 256}}


def runtime(monkeypatch, cancel=None, failure=None):
    calls = []
    class Image:
        size = (512, 256)
        def save(self, output, **kwargs):
            calls.append(('save', kwargs))
            output.write(b'pixels')
    class Pipeline:
        def __init__(self):
            self.callbacks = SimpleNamespace(register=lambda observer: setattr(self, 'observer', observer))
        def generate_image(self, **kwargs):
            calls.append(('generate', kwargs))
            if cancel:
                cancel.set()
            self.observer.call_in_loop(t=0, config=SimpleNamespace(num_inference_steps=4))
            if failure:
                raise failure
            return SimpleNamespace(image=Image())
    def load(config):
        calls.append(('load', config))
        return Pipeline(), '0.22.0', SimpleNamespace(synchronize=lambda: calls.append(('sync',)), clear_cache=lambda: calls.append(('clear',)))
    monkeypatch.setattr(mflux, 'load_pipeline', load)
    return calls


def test_mapping_order_and_metadata(monkeypatch, config, request_data):
    calls = runtime(monkeypatch)
    events = []
    result = mflux.MfluxAdapter(config).edit(request_data, Event(), events.append)
    args = next(call[1] for call in calls if call[0] == 'generate')
    assert args['image_paths'] == ['/source.png', '/a1.png', '/a2.png', '/b.png']
    assert 'Images 2, 3 are subject references for group "alice"' in args['prompt']
    assert 'Images 4 are subject references for group "bob"' in args['prompt']
    assert args['width'] == 512 and args['height'] == 256 and args['seed'] == 0
    assert result['references'] == request_data['references']
    assert result['modelRevision'] == 'a' * 40
    assert result['runtime'] == {'name': 'mflux', 'version': '0.22.0'}
    assert [e['stage'] for e in events] == ['loading', 'editing', 'editing', 'saving']
    assert calls[-1] == ('clear',)


def test_references_without_source(request_data):
    del request_data['sourceImage']
    paths, prompt = mflux.conditioning(request_data)
    assert paths == ['/a1.png', '/a2.png', '/b.png']
    assert 'Images 1, 2' in prompt


@pytest.mark.parametrize('change', [{'maskImage': '/mask.png'}, {'model': 'other'}, {'size': {'width': 17, 'height': 32}}])
def test_unsupported_inputs_never_load(monkeypatch, config, request_data, change):
    calls = runtime(monkeypatch)
    with pytest.raises(mflux.InvalidEditInput):
        mflux.MfluxAdapter(config).edit({**request_data, **change}, Event(), lambda e: None)
    assert calls == []


def test_cancel_at_step_settles_gpu_without_output(monkeypatch, config, request_data):
    cancel = Event()
    calls = runtime(monkeypatch, cancel)
    with pytest.raises(mflux.Cancelled):
        mflux.MfluxAdapter(config).edit(request_data, cancel, lambda e: None)
    assert not Path(request_data['outputPath']).exists()
    assert calls[-2:] == [('sync',), ('clear',)]


def test_pre_cancel_never_loads(monkeypatch, config, request_data):
    calls = runtime(monkeypatch)
    cancel = Event(); cancel.set()
    with pytest.raises(mflux.Cancelled):
        mflux.MfluxAdapter(config).edit(request_data, cancel, lambda e: None)
    assert calls == []


def test_output_collision_preserved(monkeypatch, config, request_data):
    runtime(monkeypatch)
    path = Path(request_data['outputPath']); path.write_bytes(b'original')
    with pytest.raises(FileExistsError):
        mflux.MfluxAdapter(config).edit(request_data, Event(), lambda e: None)
    assert path.read_bytes() == b'original'


def test_runtime_failure_releases_model(monkeypatch, config, request_data):
    calls = runtime(monkeypatch, failure=RuntimeError('private detail'))
    with pytest.raises(RuntimeError):
        mflux.MfluxAdapter(config).edit(request_data, Event(), lambda e: None)
    assert calls[-2:] == [('sync',), ('clear',)]


def test_loader_enforces_version_and_offline_before_import(monkeypatch, config):
    monkeypatch.setattr(mflux, 'version', lambda name: '0.21.0')
    for key in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']:
        monkeypatch.setenv(key, '0')
    with pytest.raises(mflux.BackendUnavailable):
        mflux.load_pipeline(config)
    import os
    assert os.environ['HF_HUB_OFFLINE'] == os.environ['TRANSFORMERS_OFFLINE'] == '1'


def test_missing_directory_never_imports(monkeypatch, config):
    for key in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']:
        monkeypatch.setenv(key, '0')
    config['directory'] += '/missing'
    monkeypatch.setattr(mflux, 'version', lambda name: pytest.fail('must not inspect packages'))
    with pytest.raises(mflux.BackendUnavailable):
        mflux.load_pipeline(config)


@pytest.mark.parametrize('quantize', [None, 4, 8])
def test_local_loader_passes_only_explicit_options(monkeypatch, config, quantize):
    import sys
    calls = []
    for key in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']:
        monkeypatch.setenv(key, '0')
    monkeypatch.setattr(mflux, 'version', lambda name: '0.22.0')
    model_config = object()
    monkeypatch.setitem(sys.modules, 'mflux.models.common.config', SimpleNamespace(
        ModelConfig=SimpleNamespace(flux2_klein_4b=lambda: model_config)))
    monkeypatch.setitem(sys.modules, 'mflux.models.flux2.variants', SimpleNamespace(
        Flux2KleinEdit=lambda **kwargs: calls.append(kwargs) or 'pipeline'))
    core = object()
    monkeypatch.setitem(sys.modules, 'mlx', SimpleNamespace(core=core))
    monkeypatch.setitem(sys.modules, 'mlx.core', core)
    if quantize:
        config['quantize'] = quantize
    assert mflux.load_pipeline(config) == ('pipeline', '0.22.0', core)
    assert calls == [{'model_config': model_config, 'model_path': config['directory'],
                      **({'quantize': quantize} if quantize else {})}]
