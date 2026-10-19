"""GLM's advertised reference semantics and unsupported input boundary."""
import importlib.util
from pathlib import Path
import pytest
from picpatch_worker_core.errors import InvalidEditInput

source = Path(__file__).resolve().parents[3] / 'runtimes/diffusers/src/picpatch_diffusers/glm.py'
spec = importlib.util.spec_from_file_location('glm_adapter', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_conditioning_keeps_source_then_every_group_image_in_order():
    paths, prompt = module.conditioning({'sourceImage': '/source.png', 'instruction': 'Arrange the scene.', 'references': [
        {'id': 'person', 'role': 'subject', 'images': ['/one.png', '/two.png']},
        {'id': 'look', 'role': 'style', 'images': ['/style.png']},
    ]})
    assert paths == ['/source.png', '/one.png', '/two.png', '/style.png']
    assert 'Image 1 is the source' in prompt
    assert 'Images 2, 3 are subject references for group "person".' in prompt
    assert prompt.endswith('Arrange the scene.')


@pytest.mark.parametrize('addition', [{'maskImage': '/mask.png'}, {'control': [{}]}, {'outpaint': {'left': 32}}])
def test_no_silent_mask_or_control_fallback(addition):
    with pytest.raises(InvalidEditInput):
        module.conditioning({'sourceImage': '/source.png', 'instruction': 'Edit.', **addition})


def test_identity_is_not_independent_binding():
    with pytest.raises(InvalidEditInput):
        module.conditioning({'instruction': 'Edit.', 'references': [{'id': 'person', 'role': 'subject', 'conditioning': 'identity', 'images': ['/person.png']}]})


def test_no_arbitrary_reference_count_limit():
    paths, _ = module.conditioning({'instruction': 'Arrange.', 'references': [{'id': 'objects', 'role': 'object', 'images': [f'/{i}.png' for i in range(20)]}]})
    assert len(paths) == 20


@pytest.mark.parametrize('option', ['quantize', 'loras', 'controlNet', 'photoMaker', 'ipAdapter'])
def test_unsupported_configuration_refused(option):
    with pytest.raises(InvalidEditInput):
        module.GlmImageAdapter({'variant': 'glm-image', option: []})


def test_capabilities_are_fresh_and_do_not_promise_masks_or_identity_binding():
    adapter = module.GlmImageAdapter({'variant': 'glm-image', 'manifest': {'model': 'fixture'}})
    caps = adapter.capabilities
    assert caps['textToImage'] and caps['instructionEditing']
    assert caps['maskMode'] == 'none'
    assert caps['referenceConditioning'] == 'ordered-images-with-role-prompt'
    caps['parameters']['steps']['default'] = 1
    assert adapter.capabilities['parameters']['steps']['default'] == 50
