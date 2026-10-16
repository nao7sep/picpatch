"""Explicit model-family selection for the MFLUX runtime."""
from .klein import KleinAdapter
from .fill import FillAdapter
from .generation import GenerationAdapter
from .errors import InvalidEditInput
from .runtime import MODEL_DEFINITIONS


def create_adapter(config):
    definition = MODEL_DEFINITIONS.get(config.get('variant'))
    if definition is None:
        raise InvalidEditInput('Unsupported model variant.')
    if definition['family'] == 'flux2-klein':
        return KleinAdapter(config)
    if definition['family'] == 'flux1-fill':
        return FillAdapter(config)
    return GenerationAdapter(config)
