"""Single-source FLUX.1 Kontext instruction editing."""
from .errors import InvalidEditInput
from .runtime import MfluxAdapter


class KontextAdapter(MfluxAdapter):
    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux.variants.kontext.flux_kontext import Flux1Kontext
        import mlx.core as mx
        return ModelConfig.dev_kontext(), Flux1Kontext, mx

    @property
    def capabilities(self):
        return {'model': self.config['manifest']['model'], 'textToImage': False,
                'instructionEditing': True, 'sourceImageRequired': True,
                'referenceRoles': [], 'maxReferenceImages': 0, 'maskMode': 'none',
                'size': {'widthMultiple': 16, 'heightMultiple': 16},
                'defaultOutputSize': {'width': 1024, 'height': 1024}}

    def generate(self, request, cancel, progress):
        raise InvalidEditInput('FLUX.1 Kontext requires a source image.')

    def edit(self, request, cancel, progress):
        if not request.get('sourceImage') or request.get('maskImage') or request.get('references'):
            raise InvalidEditInput('FLUX.1 Kontext requires one source image, without masks or reference groups.')
        return self._run(request, cancel, progress, 'edit', request['instruction'],
                         {'image_path': request['sourceImage']})
