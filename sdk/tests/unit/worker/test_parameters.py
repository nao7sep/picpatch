"""Shared sampling cases and real adapter boundary mapping without weights."""
import json
from pathlib import Path
from threading import Event

import pytest
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.errors import InvalidEditInput
from mflux_double import fake_runtime

CASES = json.loads((Path(__file__).parents[2] / 'fixtures/sampling-contract.json').read_text())

@pytest.mark.parametrize('case', CASES)
def test_shared_sampling_contract(case):
    adapter = create_adapter({'variant': case['variant'], 'manifest': {'model': case['variant']}})
    if case.get('invalid'):
        with pytest.raises(InvalidEditInput):
            adapter.sampling({'parameters': case['parameters']})
    else:
        _, effective = adapter.sampling({'parameters': case['parameters']})
        assert effective == case['effective']


def test_overrides_reach_inference_and_results_and_invalid_controls_never_load(monkeypatch, tmp_path):
    adapter = create_adapter({'variant': 'z-image', 'directory': str(tmp_path),
                              'manifest': {'model': 'z', 'source': {'revision': 'a' * 40}}})
    calls, _ = fake_runtime(monkeypatch, (adapter, 'mflux.models.z_image.variants.z_image', 'ZImage', 'z_image'))
    request = {'model': 'z', 'prompt': 'Blue', 'seed': 0, 'size': {'width': 32, 'height': 16},
               'outputPath': str(tmp_path / 'out.png'),
               'parameters': {'steps': 3, 'guidance': 2, 'negativePrompt': 'blur', 'scheduler': 'flow_match_euler_discrete'}}
    result = adapter.generate(request, Event(), lambda event: None)
    assert calls[1] == ('generate', {'seed': 0, 'prompt': 'Blue', 'width': 32, 'height': 16,
                                   'num_inference_steps': 3, 'guidance': 2, 'negative_prompt': 'blur', 'scheduler': 'flow_match_euler_discrete'})
    assert result['effectiveParameters'] == request['parameters']
    calls.clear()
    for parameters in [{'steps': 0}, {'steps': True}, {'guidance': float('inf')}, {'scheduler': 'external.Class'}, {'negativePrompt': None}]:
        with pytest.raises(InvalidEditInput):
            adapter.generate({**request, 'parameters': parameters}, Event(), lambda event: None)
        assert calls == []


def test_native_auxiliary_inputs_are_not_silently_ignored():
    config = {'variant': 'flux2-klein-4b', 'manifest': {'model': 'klein'}}
    for field in ('loras', 'controlNet'):
        with pytest.raises(InvalidEditInput):
            create_adapter({**config, field: []})
    adapter = create_adapter(config)
    with pytest.raises(InvalidEditInput):
        adapter.sampling({'control': {'kind': 'canny', 'image': '/map.png'}})
