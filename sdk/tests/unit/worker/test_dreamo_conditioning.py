"""Named DreamO references cannot silently pool or acquire another subject's slot."""
import importlib.util
from pathlib import Path
import pytest
from picpatch_worker_core.errors import InvalidEditInput

source = Path(__file__).resolve().parents[3] / 'runtimes/dreamo/src/picpatch_dreamo/conditioning.py'
spec = importlib.util.spec_from_file_location('dreamo_conditioning', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bind_references = module.bind_references


def request():
    return {'instruction': '{first} is beside {second}; {first} holds a cup.', 'references': [
        {'id': 'first', 'role': 'subject', 'conditioning': 'identity', 'images': ['/first.png']},
        {'id': 'second', 'role': 'object', 'conditioning': 'identity', 'images': ['/second.png']},
    ]}


def test_distinct_slots_follow_explicit_names():
    bindings, prompt = bind_references(request())
    assert bindings == [{'index': 1, 'path': '/first.png'}, {'index': 2, 'path': '/second.png'}]
    assert prompt == '[ref#1] is beside [ref#2]; [ref#1] holds a cup.'


@pytest.mark.parametrize('change', ['pooled', 'unnamed', 'duplicates', 'style', 'source', 'mask', 'tokens', 'class', 'braces', 'conditioning'])
def test_unsupported_subject_semantics_are_refused(change):
    value = request()
    if change == 'pooled': value['references'][0]['images'].append('/other-photo.png')
    if change == 'unnamed': value['instruction'] = 'Two people.'
    if change == 'duplicates': value['references'][1]['id'] = 'first'
    if change == 'style': value['references'][0]['role'] = 'style'
    if change == 'source': value['sourceImage'] = '/source.png'
    if change == 'mask': value['maskImage'] = '/mask.png'
    if change == 'tokens': value['instruction'] += ' [ref#2]'
    if change == 'braces': value['references'][0]['id'] = '{first}'
    if change == 'conditioning': value['references'][0]['conditioning'] = 'appearance'
    if change == 'class': value['references'][0]['className'] = 'person'
    with pytest.raises(InvalidEditInput): bind_references(value)


def test_reordering_changes_slots_without_changing_named_associations():
    value = request()
    value['references'].reverse()
    bindings, prompt = bind_references(value)
    assert bindings[0]['path'] == '/second.png'
    assert prompt == '[ref#2] is beside [ref#1]; [ref#2] holds a cup.'
