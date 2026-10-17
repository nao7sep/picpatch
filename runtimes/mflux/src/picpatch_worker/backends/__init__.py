"""Explicit model-family selection for the MFLUX runtime."""
from .klein import KleinAdapter
from .qwen import QwenAdapter
from .fill import FillAdapter
from .kontext import KontextAdapter
from .generation import GenerationAdapter
from .errors import InvalidEditInput
from .runtime import MODEL_DEFINITIONS


def create_adapter(config):
    definition = MODEL_DEFINITIONS.get(config.get('variant'))
    if definition is None:
        raise InvalidEditInput('Unsupported model variant.')
    if definition['family'] in ('qwen-edit', 'qwen21'):
        return QwenAdapter(config)
    if definition['family'] == 'flux2-klein':
        return KleinAdapter(config)
    if definition['family'] == 'flux1-fill':
        return FillAdapter(config)
    if definition['family'] == 'flux1-kontext':
        return KontextAdapter(config)
    return GenerationAdapter(config)
