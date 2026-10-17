"""Local registration and provenance stay independent of inference dependencies."""
from threading import Event
import pytest
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends import runtime
from picpatch_worker.backends.errors import InvalidEditInput
from picpatch_worker.backends.loras import lora_provenance, validate_selection
from mflux_double import fake_runtime


def configuration(directory):
    return {'variant': 'z-image', 'directory': str(directory), 'loras': [{'path': 'style.safetensors', 'scale': -0.5}],
            'manifest': {'model': 'z', 'source': {'revision': 'a' * 64},
                         'components': [{'path': 'style.safetensors', 'role': 'weights', 'sha256': 'b' * 64}]}}


@pytest.mark.parametrize('loras', [[], None, [{'path': '../style.safetensors'}], [{'path': '/style.safetensors'}],
                                 [{'path': 'style.safetensors', 'scale': float('nan')}], [{'path': 'style.safetensors', 'scale': True}],
                                 [{'path': 'undeclared.safetensors'}], [{'path': 'style.safetensors'}, {'path': 'style.safetensors'}]])
def test_reject_invalid_local_selections(tmp_path, loras):
    with pytest.raises(InvalidEditInput):
        validate_selection({**configuration(tmp_path), 'loras': loras})


def test_load_options_and_result_provenance(tmp_path, monkeypatch):
    config = configuration(tmp_path)
    adapter = create_adapter(config)
    calls, _ = fake_runtime(monkeypatch, (adapter, 'mflux.models.z_image.variants.z_image', 'ZImage', 'z_image'))
    auxiliary = {'lora_paths': [str(tmp_path / 'style.safetensors')], 'lora_scales': [-0.5], 'bake_lora': False}
    monkeypatch.setattr(runtime, 'validate_loaded_loras', lambda pipeline: None)
    monkeypatch.setattr(runtime, 'lora_kwargs', lambda selected, family: auxiliary if selected == config and family == 'z-image' else {})
    result = adapter.generate({'model': 'z', 'prompt': 'A bowl.', 'seed': 0, 'size': {'width': 32, 'height': 16}, 'outputPath': str(tmp_path / 'out.png')}, Event(), lambda event: None)
    assert all(calls[0][1][key] == value for key, value in auxiliary.items())
    assert result['loras'] == lora_provenance(config) == [{'filename': 'style.safetensors', 'scale': -0.5, 'sha256': 'b' * 64}]


@pytest.mark.parametrize(('rslora', 'expected'), [(False, 2), (True, 16)])
def test_peft_metadata_scaling(rslora, expected):
    import json
    from picpatch_worker.backends.loras import metadata_scale
    metadata = {'lora_adapter_metadata': json.dumps({'transformer.r': 64, 'transformer.lora_alpha': 128, 'transformer.use_rslora': rslora})}
    assert metadata_scale(metadata, {'transformer.x_embedder.lora_A.weight': [64, 128]}) == expected
    assert metadata_scale(None, {}) == 1


@pytest.mark.parametrize('override', [{'r': 32}, {'r': True}, {'lora_alpha': float('inf')},
                                     {'rank_pattern': {'x': 8}}, {'alpha_pattern': {'x': 8}},
                                     {'use_dora': True}, {'use_rslora': 'yes'}, {'bias': 'all'}])
def test_reject_inconsistent_or_unsupported_peft_metadata(override):
    import json
    from picpatch_worker.backends.loras import metadata_scale
    config = {'r': 64, 'lora_alpha': 128, **override}
    metadata = {'lora_adapter_metadata': json.dumps({f'transformer.{key}': value for key, value in config.items()})}
    with pytest.raises(InvalidEditInput):
        metadata_scale(metadata, {'transformer.x_embedder.lora_A.weight': [64, 128]})


@pytest.mark.parametrize('raw', ['not json', '[]', '{}', '{"text_encoder.r": 64}'])
def test_reject_invalid_peft_metadata(raw):
    from picpatch_worker.backends.loras import metadata_scale
    with pytest.raises(InvalidEditInput):
        metadata_scale({'lora_adapter_metadata': raw}, {})


def test_reject_ambiguous_tensor_and_metadata_alpha():
    from picpatch_worker.backends.loras import metadata_scale
    with pytest.raises(InvalidEditInput):
        metadata_scale({'lora_adapter_metadata': '{"transformer.r": 1, "transformer.lora_alpha": 1}'},
                       {'transformer.x.lora_A.weight': [1, 2], 'transformer.x.alpha': []})
