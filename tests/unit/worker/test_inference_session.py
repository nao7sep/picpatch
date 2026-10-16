from pathlib import Path
from threading import Event

from picpatch_worker.protocol import Protocol
from picpatch_worker.session import Session
from picpatch_worker.backends.mflux import Cancelled


def test_cancel_ack_keeps_active_until_producer_settles():
    entered, release = Event(), Event()
    replies = []
    class Backend:
        def edit(self, request, cancel, progress):
            entered.set()
            assert release.wait(2)
            assert cancel.is_set()
            raise Cancelled()
    protocol = Protocol(Path(__file__).resolve().parents[3] / 'protocol')
    session = Session(protocol, replies.append)
    session.handle({'version': 1, 'id': 1, 'type': 'hello'})
    session.adapter = Backend()
    edit = {'version': 1, 'id': 2, 'type': 'edit', 'request': {
        'model': 'test', 'instruction': 'edit', 'sourceImage': '/in.png', 'outputPath': '/out.png'}}
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
