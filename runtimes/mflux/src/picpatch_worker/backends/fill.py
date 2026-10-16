"""FLUX.1 Fill: source and mask condition denoising, without final compositing."""
from .errors import InvalidEditInput
from .runtime import MfluxAdapter


class FillAdapter(MfluxAdapter):
    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux.variants.fill.flux_fill import Flux1Fill
        import mlx.core as mx
        return ModelConfig.dev_fill(), Flux1Fill, mx

    @property
    def capabilities(self):
        return {'model': self.config['manifest']['model'], 'textToImage': False,
                'instructionEditing': True, 'sourceImageRequired': True, 'maskRequired': True,
                'referenceRoles': [], 'maxReferenceImages': 0, 'maskMode': 'native',
                'size': {'widthMultiple': 16, 'heightMultiple': 16},
                'defaultOutputSize': {'width': 1024, 'height': 1024}}

    def generate(self, request, cancel, progress):
        raise InvalidEditInput('FLUX.1 Fill requires a source image and a mask.')

    def edit(self, request, cancel, progress):
        if not request.get('sourceImage') or not request.get('maskImage') or request.get('references'):
            raise InvalidEditInput('FLUX.1 Fill requires a source and mask, without reference groups.')
        return self._run(request, cancel, progress, 'edit', request['instruction'],
                         {'image_path': request['sourceImage'], 'masked_image_path': request['maskImage']})
