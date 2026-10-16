"""JSON Lines entry point; stdout contains protocol frames only."""
import argparse
from contextlib import redirect_stdout
from pathlib import Path
import sys
from typing import BinaryIO, TextIO

from .protocol import Protocol, ProtocolError
from .session import Session


def serve(protocol: Protocol, source: BinaryIO, destination: BinaryIO, diagnostics: TextIO) -> int:
    session = Session(protocol)
    try:
        for frame in source:
            # Preserve the protocol stream even if future adapters print diagnostics.
            with redirect_stdout(diagnostics):
                response = session.handle(protocol.decode(frame))
                encoded = protocol.encode(response)
            destination.write(encoded)
            destination.flush()
            if session.closed:
                return 0
    except ProtocolError as error:
        diagnostics.write(f'PicPatch protocol error: {error}\n')
        return 2
    except BrokenPipeError:
        return 2
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='PicPatch internal worker')
    parser.add_argument('--protocol-dir', type=Path, required=True, help='Absolute directory containing protocol schemas')
    args = parser.parse_args()
    return serve(Protocol(args.protocol_dir), sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


if __name__ == '__main__':
    raise SystemExit(main())
