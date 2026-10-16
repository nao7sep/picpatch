"""Text-only families sharing the MFLUX generation API and capability contract."""
from .runtime import MfluxAdapter
from .errors import InvalidEditInput


class GenerationAdapter(MfluxAdapter):
    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        import mlx.core as mx
        if self.definition['family'] == 'z-image-turbo':
            from mflux.models.z_image.variants.z_image import ZImage
            return ModelConfig.z_image_turbo(), ZImage, mx
        if self.definition['family'] == 'flux1-schnell':
            from mflux.models.flux.variants.txt2img.flux import Flux1
            return ModelConfig.schnell(), Flux1, mx
        raise InvalidEditInput('Unsupported MFLUX generation adapter.')

    @property
    def capabilities(self):
        return {'model': self.config['manifest']['model'], 'textToImage': True,
                'instructionEditing': False, 'referenceRoles': [], 'maxReferenceImages': 0,
                'maskMode': 'none', 'size': {'widthMultiple': 16, 'heightMultiple': 16},
                'defaultOutputSize': {'width': 1024, 'height': 1024}}
