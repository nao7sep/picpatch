"""Explicit model-family selection for the MFLUX runtime."""
from .klein import KleinAdapter
from .errors import InvalidEditInput


def create_adapter(config):
    if config['adapter'] != 'mflux-flux2-klein-4b':
        raise InvalidEditInput('Unsupported MFLUX model adapter.')
    return KleinAdapter(config)
