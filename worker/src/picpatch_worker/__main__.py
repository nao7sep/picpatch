"""JSON Lines entry point; stdout contains protocol frames only."""
import argparse
from contextlib import redirect_stdout
import os
from pathlib import Path
import sys
from threading import Lock
from typing import BinaryIO, TextIO

from .protocol import Protocol, ProtocolError
from .session import Session


def serve(protocol: Protocol, source: BinaryIO, destination: BinaryIO, diagnostics: TextIO) -> int:
    writer = Lock()

    def emit(response):
        encoded = protocol.encode(response)
        with writer:
            destination.write(encoded)
            destination.flush()

    session = Session(protocol, emit)
    try:
        # Redirection covers the entire inference thread lifetime.
        with redirect_stdout(diagnostics):
            try:
                for frame in source:
                    # Serialize immediate replies with edit completion (especially cancel ACK).
                    with session.lock:
                        response = session.handle(protocol.decode(frame))
                        if response is not None:
                            emit(response)
                    if session.closed:
                        return 0
            finally:
                session.close()
    except ProtocolError as error:
        diagnostics.write(f'PicPatch protocol error: {error}\n')
        return 2
    except BrokenPipeError:
        return 2
    return 0


def deny_network(event, args):
    # Additional defense for Python download clients. Offline library flags and absolute
    # local paths are the primary boundary; this is not an OS sandbox for native code.
    if event in {'socket.connect', 'socket.getaddrinfo', 'socket.sendto'}:
        raise OSError('Network access is disabled in the editing worker.')


def main(destination=None) -> int:
    parser = argparse.ArgumentParser(description='PicPatch internal worker')
    parser.add_argument('--protocol-dir', type=Path, required=True, help='Absolute directory containing protocol schemas')
    args = parser.parse_args()
    return serve(Protocol(args.protocol_dir), sys.stdin.buffer, destination or sys.stdout.buffer, sys.stderr)


def run() -> int:
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    sys.addaudithook(deny_network)
    # Native libraries may write directly to fd 1, bypassing redirect_stdout.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'wb') as protocol_output:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        return main(protocol_output)


if __name__ == '__main__':
    raise SystemExit(run())
