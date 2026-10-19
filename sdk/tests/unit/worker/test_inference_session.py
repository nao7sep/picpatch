import pytest
from pathlib import Path
from threading import Event

from picpatch_worker_core.protocol import Protocol
from picpatch_worker_core.session import Session
from picpatch_worker.backends.errors import Cancelled


@pytest.mark.parametrize("verb", ["edit", "generate"])
def test_cancel_ack_keeps_active_until_producer_settles(verb):
    entered, release = Event(), Event()
    replies = []
    class Backend:
        def edit(self, request, cancel, progress):
            entered.set()
            assert release.wait(2)
            assert cancel.is_set()
            raise Cancelled()
        generate = edit
    protocol = Protocol(Path(__file__).resolve().parents[3] / 'protocol')
    session = Session(protocol, replies.append)
    session.handle({'version': 1, 'id': 1, 'type': 'hello'})
    session.adapter = Backend()
    edit = {'version': 1, 'id': 2, 'type': 'edit', 'request': {
        'model': 'test', 'instruction': 'edit', 'sourceImage': '/in.png', 'outputPath': '/out.png'}}
    if verb == 'generate':
        edit['type'] = 'generate'
        edit['request'] = {'model': 'test', 'prompt': 'A bowl.', 'outputPath': '/out.png'}
    try:
        assert session.handle(edit) is None
        assert entered.wait(2)
        assert session.handle({'version': 1, 'id': 3, 'type': 'cancel', 'targetId': 2})['accepted']
        assert replies == []
        assert session.handle({**edit, 'id': 4})['error']['code'] == 'BUSY'
        assert session.handle({'version': 1, 'id': 5, 'type': 'shutdown'})['error']['code'] == 'BUSY'
    finally:
        release.set(); session.close()
    assert replies[0]['error']['code'] == 'CANCELLED'
    assert session.handle({'version': 1, 'id': 6, 'type': 'shutdown'})['type'] == 'shutdownAck'


def test_runtime_error_does_not_echo_private_details():
    class Backend:
        def edit(self, *args):
            raise RuntimeError('secret /private/path')
    replies = []
    session = Session(Protocol(Path(__file__).resolve().parents[3] / 'protocol'), replies.append)
    session.handle({'version': 1, 'id': 1, 'type': 'hello'})
    session.adapter = Backend()
    session.handle({'version': 1, 'id': 2, 'type': 'edit', 'request': {
        'model': 'test', 'instruction': 'edit', 'sourceImage': '/in.png', 'outputPath': '/out.png'}})
    session.close()
    assert replies[0]['error']['code'] == 'RUNTIME_FAILURE'
    assert 'secret' not in str(replies)


def test_loading_failure_preserves_safe_causal_structure():
    class Backend:
        def edit(self, request, cancel, progress):
            progress({'type': 'progress', 'verb': 'edit', 'stage': 'loading', 'message': 'Loading.'})
            try:
                raise FileNotFoundError(2, 'private prompt sentinel', '/private/source')
            except FileNotFoundError as cause:
                raise RuntimeError('private prompt sentinel') from cause
    replies = []
    protocol = Protocol(Path(__file__).resolve().parents[3] / 'protocol')
    session = Session(protocol, replies.append)
    session.handle({'version': 1, 'id': 1, 'type': 'hello'})
    session.adapter = Backend()
    session.handle({'version': 1, 'id': 2, 'type': 'edit', 'request': {
        'model': 'test', 'instruction': 'edit', 'sourceImage': '/in.png', 'outputPath': '/out.png'}})
    session.close()
    error = replies[-1]['error']
    assert error['details']['diagnostic'] == {'phase': 'loading', 'causes': [{'kind': 'RuntimeError'}, {'kind': 'FileNotFoundError', 'errno': 2}]}
    assert 'sentinel' not in str(replies) and '/private' not in str(replies)
    protocol.validate(replies[-1], 'Response')


def test_diagnostics_bound_cycles_and_do_not_use_custom_exception_names():
    from picpatch_worker_core.session import diagnostic
    class PrivateSentinel(Exception):
        pass
    error = PrivateSentinel('secret')
    error.__cause__ = error
    assert diagnostic(error, 'saving') == {'phase': 'saving', 'causes': [{'kind': 'Exception'}]}
