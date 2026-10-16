import io
import json
from pathlib import Path

import pytest
from picpatch_worker.protocol import Protocol, ProtocolError
from picpatch_worker.session import Session
from picpatch_worker.__main__ import serve

ROOT = Path(__file__).resolve().parents[3]

@pytest.fixture
def protocol():
    return Protocol(ROOT / 'protocol')

def message(kind, identifier=1, **fields):
    return {'version': 1, 'id': identifier, 'type': kind, **fields}

def test_handshake_edit_cancel_shutdown(protocol):
    session = Session(protocol)
    assert session.handle(message('hello'))['models'] == []
    edit = {'model': 'test', 'instruction': 'Edit', 'sourceImage': '/in.png', 'outputPath': '/out.png'}
    assert session.handle(message('edit', 2, request=edit))['error']['code'] == 'BACKEND_UNAVAILABLE'
    assert session.handle(message('cancel', 3, targetId=2))['accepted'] is False
    assert session.handle(message('shutdown', 4))['type'] == 'shutdownAck'
    with pytest.raises(ProtocolError):
        session.handle(message('hello', 5))

def test_handshake_required_and_ids_not_reused(protocol):
    session = Session(protocol)
    assert session.handle(message('shutdown'))['error']['code'] == 'NOT_READY'
    session.handle(message('hello', 2))
    with pytest.raises(ProtocolError):
        session.handle(message('hello', 3))
    with pytest.raises(ProtocolError):
        session.handle(message('shutdown', 2))

@pytest.mark.parametrize('frame', [b'{}\n', b'not json\n', b'[]\n', b'{}', b'{}\n{}\n', b'\xff\n', b'{"version":NaN}\n', b'{"version":2,"id":1,"type":"hello"}\n', b'{"version":1,"id":true,"type":"hello"}\n'])
def test_bad_frames(protocol, frame):
    with pytest.raises(ProtocolError):
        protocol.decode(frame)

def test_stream_dispatch_and_stdout_isolation(protocol, monkeypatch):
    original = Session.handle
    def noisy_handle(self, request):
        print('library diagnostic')
        return original(self, request)
    monkeypatch.setattr(Session, 'handle', noisy_handle)
    source = io.BytesIO(b''.join((json.dumps(message(kind, i))+'\n').encode() for i, kind in enumerate(['hello', 'shutdown'], 1)))
    output, diagnostics = io.BytesIO(), io.StringIO()
    assert serve(protocol, source, output, diagnostics) == 0
    assert [json.loads(frame)['type'] for frame in output.getvalue().splitlines()] == ['ready', 'shutdownAck']
    assert diagnostics.getvalue().count('library diagnostic') == 2

def test_invalid_frame_stops_without_echoing_private_input(protocol):
    output, diagnostics = io.BytesIO(), io.StringIO()
    assert serve(protocol, io.BytesIO(b'private image path\n'), output, diagnostics) == 2
    assert output.getvalue() == b''
    assert 'private image path' not in diagnostics.getvalue()

@pytest.mark.parametrize('event', [{'completed': 2, 'total': 1}, {'completed': 1}, {'total': 3}])
def test_invalid_progress(protocol, event):
    with pytest.raises(ProtocolError):
        protocol.encode(message('progress', event={'type': 'progress', 'verb': 'edit', 'stage': 'loading', 'message': 'Loading', **event}))

@pytest.mark.parametrize('fixture', json.loads((ROOT / 'tests/fixtures/protocol.json').read_text()), ids=lambda item: item['name'])
def test_shared_protocol_corpus(protocol, fixture):
    if fixture['valid']:
        protocol.validate(fixture['message'], fixture['kind'])
    else:
        with pytest.raises(ProtocolError):
            protocol.validate(fixture['message'], fixture['kind'])

def test_entry_point_uses_explicit_protocol_directory(protocol, monkeypatch):
    from picpatch_worker.__main__ import main
    source = io.TextIOWrapper(io.BytesIO(b'{"version":1,"id":1,"type":"hello"}\n{"version":1,"id":2,"type":"shutdown"}\n'))
    output = io.TextIOWrapper(io.BytesIO())
    monkeypatch.setattr('sys.stdin', source)
    monkeypatch.setattr('sys.stdout', output)
    monkeypatch.setattr('sys.argv', ['picpatch_worker', '--protocol-dir', str(ROOT / 'protocol')])
    assert main() == 0
    assert [json.loads(line)['type'] for line in output.buffer.getvalue().splitlines()] == ['ready', 'shutdownAck']


def test_protocol_directory_must_be_absolute():
    with pytest.raises(ValueError):
        Protocol(Path('protocol'))

def test_eof_without_requests(protocol):
    assert serve(protocol, io.BytesIO(), io.BytesIO(), io.StringIO()) == 0


def test_closed_output_pipe(protocol):
    class ClosedPipe(io.BytesIO):
        def write(self, value):
            raise BrokenPipeError()
    assert serve(protocol, io.BytesIO(b'{"version":1,"id":1,"type":"hello"}\n'), ClosedPipe(), io.StringIO()) == 2
