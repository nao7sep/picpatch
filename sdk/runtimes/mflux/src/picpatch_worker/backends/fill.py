"""FLUX.1 Fill: source and mask condition denoising, without final compositing."""
from .errors import InvalidEditInput
from .runtime import MfluxAdapter


class FillAdapter(MfluxAdapter):
    def configure_pipeline(self, pipeline):
        from mflux.callbacks.instances.memory_saver import MemorySaver
        # One image per pipeline: encoders are dead after conditioning, the
        # transformer after denoising. Do not alter cache or VAE tiling policy.
        pipeline.callbacks.register(MemorySaver(model=pipeline, keep_transformer=False, cache_limit_bytes=None))

    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux.variants.fill.flux_fill import Flux1Fill
        import mlx.core as mx
        return ModelConfig.dev_fill(), Flux1Fill, mx

    def generate(self, request, cancel, progress):
        raise InvalidEditInput('FLUX.1 Fill requires a source image and a mask.')

    def edit(self, request, cancel, progress):
        if not request.get('sourceImage') or not request.get('maskImage') or request.get('references'):
            raise InvalidEditInput('FLUX.1 Fill requires a source and mask, without reference groups.')
        return self._run(request, cancel, progress, 'edit', request['instruction'],
                         {'image_path': request['sourceImage'], 'masked_image_path': request['maskImage']})
