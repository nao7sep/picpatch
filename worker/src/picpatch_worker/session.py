"""One active inference thread; the protocol reader remains responsive to cancellation."""
from threading import Event, RLock, Thread
import traceback
import sys
from .protocol import Protocol, ProtocolError
from .backends.mflux import MfluxAdapter, Cancelled, BackendUnavailable, InvalidEditInput, check_runtime


class Session:
    def __init__(self, protocol: Protocol, emit=None):
        self.protocol = protocol
        self.emit = emit
        self.ready = False
        self.closed = False
        self.last_id = 0
        self.adapter = None
        self.active = None
        self.thread = None
        self.cancel = Event()
        self.lock = RLock()

    def handle(self, request: dict) -> dict | None:
        with self.lock:
            return self._handle(request)

    def _handle(self, request: dict) -> dict | None:
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
            if 'model' in request:
                self.adapter = MfluxAdapter(request['model'])
            self.ready = True
            models = [self.adapter.capabilities] if self.adapter else []
            result = {**envelope, 'type': 'ready', 'workerVersion': '0.0.0', 'models': models}
            if 'runtimeCheck' in request:
                result['runtimeCheck'] = check_runtime(request['model'], request['runtimeCheck'])
            return result
        if not self.ready:
            return error('NOT_READY', 'Complete the handshake first.')
        if kind == 'shutdown':
            if self.active is not None:
                return error('BUSY', 'Settle the active edit before shutdown.')
            self.closed = True
            return {**envelope, 'type': 'shutdownAck'}
        if kind == 'cancel':
            accepted = request['targetId'] == self.active
            if accepted:
                self.cancel.set()
            return {**envelope, 'type': 'cancelAck', 'targetId': request['targetId'], 'accepted': accepted}
        if self.active is not None:
            return error('BUSY', 'An edit is already active.')
        if self.adapter is None or self.emit is None:
            return error('BACKEND_UNAVAILABLE', 'No editing backend is installed in this worker.')
        self.active = request['id']
        self.cancel = Event()
        self.thread = Thread(target=self._edit, args=(request,), daemon=False)
        self.thread.start()
        return None

    def _edit(self, request):
        envelope = {'version': 1, 'id': request['id']}
        try:
            result = self.adapter.edit(request['request'], self.cancel,
                                       lambda event: self.emit({**envelope, 'type': 'progress', 'event': event}))
            response = {**envelope, 'type': 'result', 'result': result}
        except Exception as error:
            # Authored protocol messages never echo prompts, private paths or library errors.
            if isinstance(error, Cancelled):
                code, message = 'CANCELLED', 'Editing was cancelled.'
            elif isinstance(error, BackendUnavailable):
                code, message = 'BACKEND_UNAVAILABLE', str(error)
            elif isinstance(error, InvalidEditInput):
                code, message = 'INVALID_REQUEST', 'The model could not accept these editing inputs.'
            else:
                code, message = 'RUNTIME_FAILURE', 'Local image editing failed; verify the runtime and model bundle.'
            if not isinstance(error, Cancelled):
                traceback.print_exception(error, file=sys.stderr)
            response = {**envelope, 'type': 'error', 'error': {'code': code, 'message': message}}
        with self.lock:
            try:
                self.emit(response)
            finally:
                self.active = None

    def close(self):
        self.cancel.set()
        if self.thread:
            self.thread.join()
