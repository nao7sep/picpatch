"""Text-only families sharing the MFLUX generation API and capability contract."""
from .runtime import MfluxAdapter
from .errors import InvalidEditInput


class GenerationAdapter(MfluxAdapter):
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

    @property
    def capabilities(self):
        return {'model': self.config['manifest']['model'], 'textToImage': True,
                'instructionEditing': False, 'referenceRoles': [], 'maxReferenceImages': 0,
                'maskMode': 'none', 'size': {'widthMultiple': 16, 'heightMultiple': 16},
                'defaultOutputSize': {'width': 1024, 'height': 1024}}
