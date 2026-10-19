"""Text-only families sharing the MFLUX generation API and capability contract."""
from pathlib import Path

from .runtime import MfluxAdapter
from .errors import InvalidEditInput


class GenerationAdapter(MfluxAdapter):
    def __init__(self, config):
        super().__init__(config)
        if config.get('loras') and not self.capabilities.get('loraFormats'):
            raise InvalidEditInput('This generation adapter does not support LoRAs.')

    def load_pipeline(self, operation="generate"):
        if self.definition['family'] == 'krea2':
            # External preparation fingerprints the diffusers component directories.
            # Upstream prefers these root files, so never load unrecorded overrides.
            root = Path(self.config['directory'])
            if any(root.glob('*.safetensors')):
                raise InvalidEditInput('Krea 2 requires the prepared diffusers transformer directory without root checkpoint overrides.')
        return super().load_pipeline(operation)

    def configure_pipeline(self, pipeline):
        if self.definition['family'] == 'z-image':
            from mflux.callbacks.instances.memory_saver import MemorySaver
            # Z-Image finishes all prompt encoding before its loop and releases
            # its prediction closure before decoding; no model is reused here.
            pipeline.callbacks.register(MemorySaver(model=pipeline, keep_transformer=False, cache_limit_bytes=None))

    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        import mlx.core as mx
        if self.definition['family'] == 'qwen-image':
            from mflux.models.qwen.variants.txt2img.qwen_image import QwenImage
            return getattr(ModelConfig, self.definition['config'])(), QwenImage, mx
        if self.definition['family'] == 'z-image':
            from mflux.models.z_image.variants.z_image import ZImage
            return getattr(ModelConfig, self.definition['config'])(), ZImage, mx
        if self.definition['family'] == 'flux1':
            from mflux.models.flux.variants.txt2img.flux import Flux1
            return getattr(ModelConfig, self.definition['config'])(), Flux1, mx
        if self.definition['family'] == 'ernie-image':
            from mflux.models.ernie_image.variants.txt2img.ernie_image import ErnieImage
            return getattr(ModelConfig, self.definition['config'])(), ErnieImage, mx
        if self.definition['family'] == 'krea2':
            from mflux.models.krea2.variants.txt2img.krea2 import Krea2
            return getattr(ModelConfig, self.definition['config'])(), Krea2, mx
        if self.definition['family'] == 'boogu':
            from mflux.models.boogu.variants.txt2img.boogu_image import BooguImage
            return getattr(ModelConfig, self.definition['config'])(), BooguImage, mx
        if self.definition['family'] == 'ideogram4':
            from mflux.models.ideogram4.variants.txt2img.ideogram4 import Ideogram4
            # Explicit steps select constant CFG, not the upstream variable-CFG
            # presets. Both values are recorded by our sampling contract.
            return getattr(ModelConfig, self.definition['config'])(), Ideogram4, mx
        if self.definition['family'] == 'ming-image':
            from mflux.models.ming_image.variants.ming_image import MingImage
            return getattr(ModelConfig, self.definition['config'])(), MingImage, mx
        raise InvalidEditInput('Unsupported MFLUX generation adapter.')
