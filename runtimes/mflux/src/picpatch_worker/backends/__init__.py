"""Explicit model-family selection for the MFLUX runtime."""
from .klein import KleinAdapter
from .generation import GenerationAdapter
from .errors import InvalidEditInput


def create_adapter(config):
    if config['adapter'] == 'mflux-flux2-klein-4b':
        return KleinAdapter(config)
    if config['adapter'] in {'mflux-z-image-turbo', 'mflux-flux1-schnell'}:
        return GenerationAdapter(config)
    raise InvalidEditInput('Unsupported MFLUX model adapter.')
