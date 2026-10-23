"""One active inference thread; the protocol reader remains responsive to cancellation."""
from threading import Event, RLock, Thread
from traceback import format_exception
from .protocol import Protocol, ProtocolError
from .errors import Cancelled, BackendUnavailable, InvalidEditInput


def _text(value, limit):
    try:
        return str(value)[:limit]
    except Exception:
        return object.__repr__(value)[:limit]


def diagnostic(error, phase):
    """The failure's diagnostic representation for the caller's records: each cause's type, message
    and errno, and the traceback without frame locals. The authored protocol message stays free of it."""
    causes = []
    seen = set()
    current = error
    kinds = (BackendUnavailable, ModuleNotFoundError, FileNotFoundError, PermissionError,
             MemoryError, ValueError, OSError, RuntimeError)
    while current is not None and id(current) not in seen and len(causes) < 4:
        seen.add(id(current))
        kind = next((item.__name__ for item in kinds if isinstance(current, item)), 'Exception')
        cause = {'kind': kind, 'type': _text(type(current).__qualname__, 200), 'message': _text(current, 2000)}
        if isinstance(current, OSError) and type(current.errno) is int and 0 <= current.errno <= 4095:
            cause['errno'] = current.errno
        causes.append(cause)
        current = current.__cause__ or (None if current.__suppress_context__ else current.__context__)
    result = {'phase': phase, 'causes': causes, 'traceback': ''.join(format_exception(error))[-16000:]}
    if isinstance(error, BackendUnavailable) and error.reason in {'missing-package', 'unsupported-version', 'missing-directory'}:
        result['reason'] = error.reason
    return result


class Session:
    def __init__(self, protocol: Protocol, emit=None, adapter_factory=None):
        self.adapter_factory = adapter_factory
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
            return {**envelope, 'type': 'error', 'error': {'code': code, 'kind': self.protocol.error_codes[code], 'effect': 'none', 'message': message, 'details': {}}}

        kind = request['type']
        if kind == 'hello':
            if self.ready:
                raise ProtocolError('Handshake already completed.')
            if 'model' in request:
                if self.adapter_factory is None:
                    raise ProtocolError('No adapter factory for model handshake.')
                self.adapter = self.adapter_factory(request['model'])
            self.ready = True
            models = [self.adapter.capabilities] if self.adapter else []
            result = {**envelope, 'type': 'ready', 'workerVersion': self.protocol.sdk_version, 'models': models}
            if 'runtimeCheck' in request:
                result['runtimeCheck'] = self.adapter.inspect_runtime(request['runtimeCheck'])
            return result
        if not self.ready:
            return error('PROTOCOL_ERROR', 'Complete the handshake first.')
        if kind == 'shutdown':
            if self.active is not None:
                return error('PROTOCOL_ERROR', 'Settle the active operation before shutdown.')
            self.closed = True
            return {**envelope, 'type': 'shutdownAck'}
        if kind == 'cancel':
            accepted = request['targetId'] == self.active
            if accepted:
                self.cancel.set()
            return {**envelope, 'type': 'cancelAck', 'targetId': request['targetId'], 'accepted': accepted}
        if self.active is not None:
            return error('PROTOCOL_ERROR', 'An operation is already active.')
        if self.adapter is None or self.emit is None:
            return error('BACKEND_UNAVAILABLE', 'No image backend is installed in this worker.')
        self.active = request['id']
        self.cancel = Event()
        self.thread = Thread(target=self._run, args=(request,), daemon=False)
        self.thread.start()
        return None

    def _run(self, request):
        envelope = {'version': 1, 'id': request['id']}
        phase = 'generating' if request['type'] == 'generate' else 'editing'

        def progress(event):
            nonlocal phase
            if event['stage'] in {'loading', 'editing', 'generating', 'saving'}:
                phase = event['stage']
            self.emit({**envelope, 'type': 'progress' if 'completed' in event else 'event', 'event': event})

        try:
            operation = self.adapter.generate if request['type'] == 'generate' else self.adapter.edit
            result = operation(request['request'], self.cancel, progress)
            response = {**envelope, 'type': 'result', 'result': result}
        except Exception as error:
            # Authored protocol messages never echo prompts, private paths or library errors; the diagnostic carries them.
            if isinstance(error, Cancelled):
                code, message = 'CANCELLED', 'Image operation was cancelled.'
            elif isinstance(error, BackendUnavailable):
                code = {'missing-package': 'DEPENDENCY_MISSING', 'unsupported-version': 'DEPENDENCY_INCOMPATIBLE', 'missing-directory': 'FILE_NOT_FOUND'}.get(error.reason, 'BACKEND_UNAVAILABLE')
                message = 'The local inference runtime or model bundle is unavailable.'
            elif isinstance(error, InvalidEditInput):
                code, message = 'INVALID_REQUEST', 'The model could not accept these image inputs.'
            elif isinstance(error, FileNotFoundError):
                code, message = 'FILE_NOT_FOUND', 'A required local file is missing.'
            elif isinstance(error, PermissionError):
                code, message = 'PERMISSION_DENIED', 'A local file is not accessible.'
            elif isinstance(error, MemoryError):
                code, message = 'OUT_OF_MEMORY', 'The runtime could not allocate memory.'
            else:
                code, message = 'RUNTIME_FAILURE', 'Local image operation failed; verify the runtime and model bundle.'
            # The worker writes only its caller-owned private workspace. The client
            # classifies publication/cleanup effects after process settlement.
            response = {**envelope, 'type': 'error', 'error': {'code': code, 'kind': self.protocol.error_codes[code], 'effect': 'none', 'message': message, 'details': {'diagnostic': diagnostic(error, phase)}}}
        with self.lock:
            try:
                self.emit(response)
            finally:
                self.active = None

    def close(self):
        self.cancel.set()
        if self.thread:
            self.thread.join()
