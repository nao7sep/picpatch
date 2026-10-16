"""Model-free session dispatch. No inference dependencies are imported here."""
from .protocol import Protocol, ProtocolError


class Session:
    def __init__(self, protocol: Protocol):
        self.protocol = protocol
        self.ready = False
        self.closed = False
        self.last_id = 0

    def handle(self, request: dict) -> dict:
        self.protocol.validate(request, 'Request')
        if self.closed or request['id'] <= self.last_id:
            raise ProtocolError('Session closed or non-increasing request ID.')
        self.last_id = request['id']
        envelope = {'version': 1, 'id': request['id']}

        def error(code: str, message: str) -> dict:
            return {**envelope, 'type': 'error', 'error': {'code': code, 'message': message}}

        kind = request['type']
        if kind == 'hello':
            if self.ready:
                raise ProtocolError('Handshake already completed.')
            self.ready = True
            return {**envelope, 'type': 'ready', 'workerVersion': '0.0.0', 'models': []}
        if not self.ready:
            return error('NOT_READY', 'Complete the handshake first.')
        if kind == 'shutdown':
            self.closed = True
            return {**envelope, 'type': 'shutdownAck'}
        if kind == 'cancel':
            # No asynchronous edit can be active until an inference adapter is implemented.
            return {**envelope, 'type': 'cancelAck', 'targetId': request['targetId'], 'accepted': False}
        return error('BACKEND_UNAVAILABLE', 'No editing backend is installed in this worker.')
