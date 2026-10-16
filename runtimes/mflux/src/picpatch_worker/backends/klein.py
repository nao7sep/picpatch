"""FLUX.2 Klein 4B conditioning and composite-mask behavior."""
import json
from threading import Event
from .errors import InvalidEditInput
from .runtime import MfluxAdapter


def conditioning(request: dict) -> tuple[list[str], str]:
    """Flatten source then groups, explicitly associating every ordinal with its role."""
    paths = []
    descriptions = []
    if request.get('sourceImage'):
        paths.append(request['sourceImage'])
        descriptions.append('Image 1 is the source image to edit.')
    for group in request.get('references', []):
        numbers = []
        for image in group['images']:
            paths.append(image)
            numbers.append(str(len(paths)))
        descriptions.append(f"Images {', '.join(numbers)} are {group['role']} references for group {json.dumps(group['id'])}.")
    if not paths or (request.get('maskImage') and not request.get('sourceImage')):
        raise InvalidEditInput('Editing requires images; masked editing requires a source.')
    return paths, '\n'.join(descriptions) + '\n\n' + request['instruction']


def composite_mask(generated, request):
    """sRGB channel interpolation, including alpha; black pixels copy the source exactly.

    The mask never conditions Klein. The SDK supplies normalized, aligned snapshots.
    Pillow's native pixel loop stays inside the owned inference thread.
    """
    if not request.get('maskImage'):
        return generated
    from PIL import Image
    with Image.open(request['sourceImage']) as source, Image.open(request['maskImage']) as mask:
        if mask.mode != 'L' or source.size != mask.size or generated.size != source.size:
            raise InvalidEditInput('Masked output and grayscale mask must match the source dimensions.')
        return Image.composite(generated.convert('RGBA'), source.convert('RGBA'), mask)


class KleinAdapter(MfluxAdapter):
    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
        import mlx.core as mx
        return ModelConfig.flux2_klein_4b(), Flux2KleinEdit if operation == 'edit' else Flux2Klein, mx

    def transform_output(self, image, request):
        return composite_mask(image, request)

    @property
    def capabilities(self) -> dict:
        return {'model': self.config['manifest']['model'], 'instructionEditing': True, 'textToImage': True,
                'referenceRoles': ['subject', 'object', 'style', 'background'],
                'maskMode': 'composite', 'size': {'widthMultiple': 16, 'heightMultiple': 16},
                'sourceImageRequired': False, 'referenceConditioning': 'ordered-images-with-role-prompt',
                'defaultOutputSize': {'width': 1024, 'height': 1024}, 'inputGeometry': 'klein-reference'}

    def edit(self, request: dict, cancel: Event, progress) -> dict:
        paths, prompt = conditioning(request)
        return self._run(request, cancel, progress, 'edit', prompt, {'image_paths': paths})
