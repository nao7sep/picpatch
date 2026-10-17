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

    def edit(self, request, cancel, progress):
        if request.get('maskImage'):
            # Qwen 2.1's sampler preservation is not trained inpaint conditioning.
            # Expose it only after giving that mechanism its own public contract.
            raise InvalidEditInput('This Qwen adapter does not expose masked editing.')
        paths, prompt = conditioning(request)
        maximum = self.capabilities.get('maxConditioningImages')
        if maximum is not None and len(paths) > maximum:
            raise InvalidEditInput('The total source and reference count exceeds the model limit.')
        return self._run(request, cancel, progress, 'edit', prompt, {'image_paths': paths})
