"""Versioned, model-free JSON Lines protocol validation."""
import json
from pathlib import Path

from jsonschema import Draft7Validator
from referencing import Registry, Resource


class ProtocolError(ValueError):
    """An invalid frame requires the transport to close the session."""


class Protocol:
    def __init__(self, directory: Path):
        if not directory.is_absolute():
            raise ValueError('Protocol directory must be absolute.')
        self.error_codes = json.loads((directory / 'error-codes.json').read_text())
        # The worker is part of the SDK, so it reports the SDK's version from the SDK's manifest.
        self.sdk_version = json.loads((directory.parent / 'package.json').read_text())['version']
        contracts = json.loads((directory / 'contracts.schema.json').read_text())
        worker = json.loads((directory / 'worker.schema.json').read_text())
        registry = Registry().with_resources([
            ('contracts.schema.json', Resource.from_contents(contracts)),
            ('worker.schema.json', Resource.from_contents(worker)),
        ])
        self.validators = {
            kind: Draft7Validator({'$ref': f'worker.schema.json#/definitions/{kind}'}, registry=registry)
            for kind in ('Request', 'Response')
        }

    def validate(self, value: object, kind: str) -> None:
        if not self.validators[kind].is_valid(value):
            raise ProtocolError('Invalid message or unsupported protocol version.')
        if value['type'] == 'error' and self.error_codes.get(value['error']['code']) != value['error']['kind']:
            raise ProtocolError('Invalid error code or kind.')
        if value['type'] == 'progress':
            event = value['event']
            if ('completed' in event) != ('total' in event) or event.get('completed', 0) > event.get('total', 0):
                raise ProtocolError('Invalid progress counters.')

    def decode(self, frame: bytes) -> dict:
        if not frame.endswith(b'\n') or b'\n' in frame[:-1] or b'\r' in frame:
            raise ProtocolError('Expected a newline-terminated JSON frame.')
        try:
            value = json.loads(frame.decode('utf-8'), parse_constant=self._reject_constant)
        except (ValueError, UnicodeError) as error:
            raise ProtocolError('Invalid JSON frame.') from error
        self.validate(value, 'Request')
        return value

    @staticmethod
    def _reject_constant(value: str):
        raise ValueError('Non-finite JSON number.')

    def encode(self, value: dict) -> bytes:
        self.validate(value, 'Response')
        return (json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
