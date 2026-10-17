"""Qwen editing contracts; 2.1 uses its complete vision-capable pipeline for both verbs."""
from .conditioning import conditioning
from .errors import InvalidEditInput
from .runtime import MfluxAdapter


class QwenAdapter(MfluxAdapter):
    def import_pipeline(self, operation):
        from mflux.models.common.config import ModelConfig
        import mlx.core as mx
        if self.definition['family'] == 'qwen21':
            from mflux.models.qwen21.variants.edit.qwen_image_21_edit import QwenImage21Edit
            pipeline = QwenImage21Edit
        else:
            from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
            pipeline = QwenImageEdit
        return getattr(ModelConfig, self.definition['config'])(), pipeline, mx

    def generate(self, request, cancel, progress):
        if not self.capabilities['textToImage']:
            raise InvalidEditInput('Qwen Image Edit requires image conditioning.')
        return super().generate(request, cancel, progress)

    def transform_output(self, image, request):
        if not request.get('maskImage'):
            return image
        from PIL import Image
        with Image.open(request['sourceImage']) as source, Image.open(request['maskImage']) as mask:
            if source.size != image.size or mask.size != image.size:
                raise InvalidEditInput('Masked output must match the source and mask dimensions.')
            # Upstream already blends soft masks. Restore only fully black pixels after
            # float decoding, so RGBA bytes are exact without applying soft alpha twice.
            edited = mask.point(lambda value: 255 if value else 0)
            return Image.composite(image.convert('RGBA'), source.convert('RGBA'), edited)

    def edit(self, request, cancel, progress):
        _, effective = self.sampling(request)
        if effective.get('strength', 1) < 1 and not request.get('sourceImage'):
            raise InvalidEditInput('Source-strength control requires a source image.')
        if request.get('maskImage'):
            if self.definition['family'] != 'qwen21' or not request.get('sourceImage'):
                raise InvalidEditInput('Masked Qwen editing requires Qwen 2.1 and a source image.')
            from PIL import Image
            with Image.open(request['sourceImage']) as source, Image.open(request['maskImage']) as mask:
                size = request.get('size', {'width': source.width, 'height': source.height})
                if mask.mode != 'L' or mask.size != source.size or source.size != (size['width'], size['height']):
                    raise InvalidEditInput('Source, grayscale mask and output dimensions must match.')
        paths, prompt = conditioning(request)
        maximum = self.capabilities.get('maxConditioningImages')
        if maximum is not None and len(paths) > maximum:
            raise InvalidEditInput('The total source and reference count exceeds the model limit.')
        return self._run(request, cancel, progress, 'edit', prompt, {'image_paths': paths, **({'mask_image': request['maskImage']} if request.get('maskImage') else {})})
