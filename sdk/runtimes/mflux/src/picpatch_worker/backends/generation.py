"""Text-only families sharing the MFLUX generation API and capability contract."""
from .runtime import MfluxAdapter
from .errors import InvalidEditInput


class GenerationAdapter(MfluxAdapter):
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
        raise InvalidEditInput('Unsupported MFLUX generation adapter.')
