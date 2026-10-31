"""Adapter contract tests substitute only the outbound model runtime; no weights needed."""
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
from picpatch_worker.backends import klein, runtime as mflux_runtime
from picpatch_worker.backends.errors import Cancelled, BackendUnavailable


@pytest.fixture
def config(tmp_path):
    return {'variant': 'flux2-klein-4b', 'directory': str(tmp_path), 'manifest': {
        'model': 'local-klein', 'source': {'repository': 'local', 'revision': 'a' * 40},
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
    def load(self, operation="edit"):
        config = self.config
        calls.append(('load', config))
        calls.append(('operation', operation))
        return Pipeline(), '0.22.0', SimpleNamespace(synchronize=lambda: calls.append(('sync',)), clear_cache=lambda: calls.append(('clear',)))
    monkeypatch.setattr(klein.KleinAdapter, 'load_pipeline', load)
    return calls


def test_mapping_order_and_metadata(monkeypatch, config, request_data):
    calls = runtime(monkeypatch)
    events = []
    result = klein.KleinAdapter(config).edit(request_data, Event(), events.append)
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
    paths, prompt = klein.conditioning(request_data)
    assert paths == ['/a1.png', '/a2.png', '/b.png']
    assert 'Images 1, 2' in prompt


@pytest.mark.parametrize('change', [{'model': 'other'}, {'size': {'width': 17, 'height': 32}}])
def test_unsupported_inputs_never_load(monkeypatch, config, request_data, change):
    calls = runtime(monkeypatch)
    with pytest.raises(klein.InvalidEditInput):
        klein.KleinAdapter(config).edit({**request_data, **change}, Event(), lambda e: None)
    assert calls == []


def test_cancel_at_step_settles_gpu_without_output(monkeypatch, config, request_data):
    cancel = Event()
    calls = runtime(monkeypatch, cancel)
    with pytest.raises(Cancelled):
        klein.KleinAdapter(config).edit(request_data, cancel, lambda e: None)
    assert not Path(request_data['outputPath']).exists()
    assert calls[-2:] == [('sync',), ('clear',)]


def test_pre_cancel_never_loads(monkeypatch, config, request_data):
    calls = runtime(monkeypatch)
    cancel = Event(); cancel.set()
    with pytest.raises(Cancelled):
        klein.KleinAdapter(config).edit(request_data, cancel, lambda e: None)
    assert calls == []


def test_output_collision_preserved(monkeypatch, config, request_data):
    runtime(monkeypatch)
    path = Path(request_data['outputPath']); path.write_bytes(b'original')
    with pytest.raises(FileExistsError):
        klein.KleinAdapter(config).edit(request_data, Event(), lambda e: None)
    assert path.read_bytes() == b'original'


def test_runtime_failure_releases_model(monkeypatch, config, request_data):
    calls = runtime(monkeypatch, failure=RuntimeError('private detail'))
    with pytest.raises(RuntimeError):
        klein.KleinAdapter(config).edit(request_data, Event(), lambda e: None)
    assert calls[-2:] == [('sync',), ('clear',)]


def test_loader_requires_mflux_and_goes_offline_before_import(monkeypatch, config):
    def missing(name):
        raise mflux_runtime.PackageNotFoundError(name)
    monkeypatch.setattr(mflux_runtime, 'version', missing)
    for key in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']:
        monkeypatch.setenv(key, '0')
    with pytest.raises(BackendUnavailable):
        klein.KleinAdapter(config).load_pipeline()
    import os
    assert os.environ['HF_HUB_OFFLINE'] == os.environ['TRANSFORMERS_OFFLINE'] == '1'


def test_missing_directory_never_imports(monkeypatch, config):
    for key in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']:
        monkeypatch.setenv(key, '0')
    config['directory'] += '/missing'
    monkeypatch.setattr(mflux_runtime, 'version', lambda name: pytest.fail('must not inspect packages'))
    with pytest.raises(BackendUnavailable):
        klein.KleinAdapter(config).load_pipeline()


@pytest.mark.parametrize('quantize', [None, 4, 8])
@pytest.mark.parametrize('operation', ['edit', 'generate'])
def test_local_loader_passes_only_explicit_options(monkeypatch, config, quantize, operation):
    import sys
    calls = []
    for key in ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY']:
        monkeypatch.setenv(key, '0')
    monkeypatch.setattr(mflux_runtime, 'version', lambda name: '0.22.0')
    model_config = object()
    monkeypatch.setitem(sys.modules, 'mflux.models.common.config', SimpleNamespace(
        ModelConfig=SimpleNamespace(flux2_klein_4b=lambda: model_config)))
    registered = []
    pipelines = {name: SimpleNamespace(callbacks=SimpleNamespace(register=registered.append)) for name in ('edit', 'generate')}
    monkeypatch.setitem(sys.modules, 'mflux.callbacks.instances.memory_saver', SimpleNamespace(
        MemorySaver=lambda **kwargs: kwargs))
    monkeypatch.setitem(sys.modules, 'mflux.models.flux2.variants', SimpleNamespace(
        Flux2KleinEdit=lambda **kwargs: calls.append(kwargs) or pipelines['edit'],
        Flux2Klein=lambda **kwargs: calls.append(kwargs) or pipelines['generate']))
    core = object()
    monkeypatch.setitem(sys.modules, 'mlx', SimpleNamespace(core=core))
    monkeypatch.setitem(sys.modules, 'mlx.core', core)
    if quantize:
        config['quantize'] = quantize
    assert klein.KleinAdapter(config).load_pipeline(operation) == (pipelines[operation], '0.22.0', core)
    assert registered == [{'model': pipelines[operation], 'keep_transformer': False}]
    assert calls == [{'model_config': model_config, 'model_path': config['directory'],
                      **({'quantize': quantize} if quantize else {})}]


def test_runtime_readiness_distinguishes_missing_version_and_imports(monkeypatch, config):
    def missing(_):
        raise mflux_runtime.PackageNotFoundError('mflux')
    monkeypatch.setattr(mflux_runtime, 'version', missing)
    assert klein.KleinAdapter(config).inspect_runtime('imports')['status'] == 'missing-package'
    monkeypatch.setattr(mflux_runtime, 'version', lambda _: '0.0.0')
    assert klein.KleinAdapter(config).inspect_runtime('imports')['status'] == 'unsupported-version'
    monkeypatch.setattr(mflux_runtime, 'version', lambda _: '0.22.0')
    monkeypatch.setattr(klein.KleinAdapter, 'import_pipeline', lambda *args: None)
    assert klein.KleinAdapter(config).inspect_runtime('imports')['status'] == 'imports-ready'


def test_runtime_readiness_does_not_echo_import_failures(monkeypatch, config):
    monkeypatch.setattr(mflux_runtime, 'version', lambda _: '0.22.0')
    def fail(*args):
        raise RuntimeError('private sentinel')
    monkeypatch.setattr(klein.KleinAdapter, 'import_pipeline', fail)
    assert klein.KleinAdapter(config).inspect_runtime('imports') == {'status': 'import-failed', 'version': '0.22.0'}


def test_runtime_readiness_load_releases_resources(monkeypatch, config):
    monkeypatch.setattr(mflux_runtime, 'version', lambda _: '0.22.0')
    monkeypatch.setattr(klein.KleinAdapter, 'import_pipeline', lambda *args: None)
    calls = runtime(monkeypatch)
    assert klein.KleinAdapter(config).inspect_runtime('load')['status'] == 'load-ready'
    assert calls[-2:] == [('sync',), ('clear',)]
    def fail(*args):
        raise RuntimeError('private sentinel')
    monkeypatch.setattr(klein.KleinAdapter, 'load_pipeline', fail)
    assert klein.KleinAdapter(config).inspect_runtime('load') == {'status': 'load-failed', 'version': '0.22.0'}


# Shared with TypeScript: metadata acceptance must agree with actual adapter mapping.
import json
CONTRACT = json.loads((Path(__file__).resolve().parents[2] / 'fixtures' / 'klein-contract.json').read_text())


def test_capabilities_match_shared_contract(config):
    adapter = klein.KleinAdapter(config)
    assert adapter.capabilities == CONTRACT['capabilities']
    changed = adapter.capabilities
    changed['referenceRoles'].clear()
    assert adapter.capabilities == CONTRACT['capabilities']


@pytest.mark.parametrize('case', CONTRACT['cases'], ids=lambda case: case['name'])
def test_shared_conditioning_reaches_runtime(monkeypatch, config, tmp_path, case):
    calls = runtime(monkeypatch)
    request = {**case['request'], 'outputPath': str(tmp_path / 'out.png')}
    klein.KleinAdapter(config).edit(request, Event(), lambda event: None)
    args = next(call[1] for call in calls if call[0] == 'generate')
    assert args['image_paths'] == case['paths']
    assert args['prompt'] == case['prompt']
    expected_size = request.get('size', CONTRACT['capabilities']['defaultOutputSize'])
    assert (args['width'], args['height']) == (expected_size['width'], expected_size['height'])


def test_group_ids_are_quoted_and_instruction_is_preserved():
    request = {'references': [{'id': 'shape"\nlabel', 'role': 'object', 'images': ['/shape.png']}],
               'instruction': 'Keep this exact instruction.'}
    _, prompt = klein.conditioning(request)
    assert 'group "shape\\"\\nlabel".' in prompt
    assert prompt.endswith('\n\n' + request['instruction'])


def test_mask_is_composited_after_generation_without_becoming_a_reference(monkeypatch, config, request_data):
    calls = runtime(monkeypatch)
    seen = []
    def composite(image, request):
        seen.append(request['maskImage'])
        return image
    monkeypatch.setattr(klein, 'composite_mask', composite)
    request_data['maskImage'] = '/mask.png'
    klein.KleinAdapter(config).edit(request_data, Event(), lambda event: None)
    assert seen == ['/mask.png']
    args = next(call[1] for call in calls if call[0] == 'generate')
    assert '/mask.png' not in args['image_paths']


def test_adapter_selection_is_explicit(config):
    from picpatch_worker.backends import create_adapter
    from picpatch_worker.backends.errors import InvalidEditInput
    assert isinstance(create_adapter(config), klein.KleinAdapter)
    with pytest.raises(InvalidEditInput):
        create_adapter({**config, 'variant': 'unknown'})


def test_generation_has_no_image_conditioning(monkeypatch, config, tmp_path):
    calls = runtime(monkeypatch)
    events = []
    request = {'model': 'local-klein', 'prompt': 'A blue ceramic bowl.',
               'outputPath': str(tmp_path / 'generated.png'), 'seed': 0,
               'size': {'width': 512, 'height': 256}}
    result = klein.KleinAdapter(config).generate(request, Event(), events.append)
    args = next(call[1] for call in calls if call[0] == 'generate')
    assert args == {'seed': 0, 'prompt': request['prompt'], 'width': 512, 'height': 256}
    assert ('operation', 'generate') in calls
    assert result['references'] == [] and result['seed'] == 0
    assert {event['verb'] for event in events} == {'generate'}
    assert [event['stage'] for event in events] == ['loading', 'generating', 'generating', 'saving']
    assert calls[-1] == ('clear',)


@pytest.mark.parametrize('variant,method,base', [
    ('flux2-klein-4b', 'flux2_klein_4b', False),
    ('flux2-klein-9b', 'flux2_klein_9b', False),
    ('flux2-klein-base-4b', 'flux2_klein_base_4b', True),
    ('flux2-klein-base-9b', 'flux2_klein_base_9b', True),
])
@pytest.mark.parametrize('operation', ['generate', 'edit'])
def test_variant_pipeline_and_sampling_defaults(monkeypatch, config, request_data, variant, method, base, operation):
    import sys
    from picpatch_worker.backends import create_adapter
    config['variant'] = variant
    selected = object()
    generate_class, edit_class, core = object(), object(), object()
    monkeypatch.setitem(sys.modules, 'mflux.models.common.config', SimpleNamespace(ModelConfig=SimpleNamespace(**{method: lambda: selected})))
    monkeypatch.setitem(sys.modules, 'mflux.models.flux2.variants', SimpleNamespace(Flux2Klein=generate_class, Flux2KleinEdit=edit_class))
    monkeypatch.setitem(sys.modules, 'mlx', SimpleNamespace(core=core))
    monkeypatch.setitem(sys.modules, 'mlx.core', core)
    adapter = create_adapter(config)
    assert adapter.import_pipeline(operation) == (selected, edit_class if operation == 'edit' else generate_class, core)
    calls = runtime(monkeypatch)
    request_data['prompt'] = 'A blue bowl.'
    getattr(adapter, operation)(request_data, Event(), lambda event: None)
    args = next(call[1] for call in calls if call[0] == 'generate')
    if base:
        assert args['num_inference_steps'] == 50 and args['guidance'] == 4.0
    else:
        assert 'num_inference_steps' not in args and 'guidance' not in args
    assert ('image_paths' in args) == (operation == 'edit')
