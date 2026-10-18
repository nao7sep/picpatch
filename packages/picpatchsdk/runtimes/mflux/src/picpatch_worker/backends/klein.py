"""FLUX.2 Klein family conditioning and composite-mask behavior."""
from threading import Event
from .errors import InvalidEditInput
from .runtime import MfluxAdapter
from .conditioning import conditioning


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
    def configure_pipeline(self, pipeline):
        from mflux.callbacks.instances.memory_saver import MemorySaver
        # Each operation owns a fresh single-image pipeline. Encoders are dead after
        # prompt encoding, and the transformer is dead before VAE decoding.
        pipeline.callbacks.register(MemorySaver(model=pipeline, keep_transformer=False))

    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
        import mlx.core as mx
        return getattr(ModelConfig, self.definition['config'])(), Flux2KleinEdit if operation == 'edit' else Flux2Klein, mx

    def transform_output(self, image, request):
        return composite_mask(image, request)

    def edit(self, request: dict, cancel: Event, progress) -> dict:
        paths, prompt = conditioning(request)
        return self._run(request, cancel, progress, 'edit', prompt, {'image_paths': paths})
