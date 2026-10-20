"""Shared offline MFLUX loading, inference settlement and pixel-only output."""
import gc
import copy
import math
import json
from importlib.metadata import version, PackageNotFoundError
import os
from pathlib import Path
import secrets
from threading import Event


from .errors import Cancelled, InvalidEditInput, BackendUnavailable

# The MFLUX release this adapter's API contract was written against; a test checks it against the lock pin.
MFLUX_VERSION = '0.22.0'
from .loras import validate_selection, lora_kwargs, lora_provenance, validate_loaded_loras


def check_cancelled(cancel: Event) -> None:
    if cancel.is_set():
        raise Cancelled()


class StepObserver:
    def __init__(self, cancel: Event, emit, stage="editing"):
        self.cancel = cancel
        self.emit = emit
        self.stage = stage

    def call_before_loop(self, **kwargs):
        check_cancelled(self.cancel)

    def call_in_loop(self, t, config, **kwargs):
        check_cancelled(self.cancel)
        self.emit(self.stage, 'Denoising image.', int(t) + 1, int(config.num_inference_steps))

    def call_after_loop(self, **kwargs):
        check_cancelled(self.cancel)


MODEL_DEFINITIONS = {item['id']: item for item in json.loads((Path(__file__).with_name('models.json')).read_text())}


class MfluxAdapter:
    def __init__(self, config: dict):
        if 'controlNet' in config:
            raise InvalidEditInput('This runtime does not support these auxiliary assets.')
        validate_selection(config)
        self.config = config
        try:
            self.definition = MODEL_DEFINITIONS[config['variant']]
        except KeyError as error:
            raise InvalidEditInput('Unsupported model variant.') from error

    @property
    def capabilities(self):
        return {**copy.deepcopy(self.definition['capabilities']), 'model': self.config['manifest']['model']}

    def sampling(self, request, operation="edit"):
        if 'control' in request:
            raise InvalidEditInput('This runtime does not support structural control.')
        supported = self.capabilities['parameters']
        supplied = request.get('parameters', {})
        if not isinstance(supplied, dict) or any(key not in supported for key in supplied):
            raise InvalidEditInput('Unsupported sampling parameter.')
        if operation != 'edit' and 'strength' in supplied:
            raise InvalidEditInput('Source strength is only supported for editing.')
        effective = {}
        for key, descriptor in supported.items():
            if key == 'strength' and operation != 'edit':
                continue
            value = supplied.get(key, descriptor.get('default'))
            if value is None:
                if key in supplied:
                    raise InvalidEditInput('Invalid sampling parameter.')
                continue
            if key in ('steps', 'guidance', 'strength'):
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < descriptor['minimum'] or (descriptor.get('minimumExclusive') and value == descriptor['minimum']) or value > descriptor.get('maximum', math.inf) or (descriptor.get('integer') and int(value) != value):
                    raise InvalidEditInput('Invalid sampling range.')
            elif not isinstance(value, str) or (key == 'scheduler' and value not in descriptor['values']):
                raise InvalidEditInput('Invalid sampling choice.')
            effective[key] = value
        negative = supported.get('negativePrompt', {})
        guidance = effective.get('guidance', 0)
        if 'negativePrompt' in effective and 'requiresGuidanceAbove' in negative and guidance <= negative['requiresGuidanceAbove']:
            raise InvalidEditInput('Negative prompt requires active guidance.')
        if 'negativePrompt' not in effective and 'requiredForGuidanceAbove' in negative and guidance > negative['requiredForGuidanceAbove']:
            raise InvalidEditInput('Guidance requires an explicit negative prompt.')
        names = {'steps': 'num_inference_steps', 'guidance': 'guidance', 'negativePrompt': 'negative_prompt', 'scheduler': 'scheduler', 'strength': 'strength'}
        # Preserve upstream defaults unless the caller or our model definition sets an override.
        kwargs = {**self.definition['defaults'], **{names[key]: value for key, value in supplied.items()}}
        return kwargs, effective

    def configure_pipeline(self, pipeline):
        pass

    def load_pipeline(self, operation="generate"):
        # Set before importing HF/Transformers: these libraries cache environment settings.
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
        directory = Path(self.config['directory'])
        if not directory.is_absolute() or not directory.is_dir():
            raise BackendUnavailable('Supply an existing absolute local model directory.', 'missing-directory')
        try:
            installed = version('mflux')
        except PackageNotFoundError as error:
            raise BackendUnavailable(f'Install MFLUX {MFLUX_VERSION} in the supplied worker environment.', 'missing-package') from error
        # Inference runs only in a managed engine, whose packages its probe matched to the lock when it was installed.
        auxiliary = lora_kwargs(self.config, self.definition['family'])
        model_config, pipeline_class, mx = self.import_pipeline(operation)
        kwargs = {'model_config': model_config, 'model_path': str(directory), **auxiliary}
        if 'quantize' in self.config:
            kwargs['quantize'] = self.config['quantize']
        pipeline = None
        try:
            pipeline = pipeline_class(**kwargs)
            if auxiliary:
                validate_loaded_loras(pipeline)
            self.configure_pipeline(pipeline)
            return pipeline, installed, mx
        except Exception:
            mx.synchronize()
            pipeline = None
            gc.collect()
            mx.clear_cache()
            raise

    def inspect_runtime(self, mode: str) -> dict:
        """Authored status only: never forward arbitrary package exception text."""
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
        try:
            installed = version('mflux')
        except PackageNotFoundError:
            return {'status': 'missing-package'}
        if installed != MFLUX_VERSION:
            return {'status': 'unsupported-version', 'version': installed}
        try:
            self.import_pipeline("generate")
        except ModuleNotFoundError:
            return {'status': 'missing-package', 'version': installed}
        except Exception:
            return {'status': 'import-failed', 'version': installed}
        if mode == 'imports':
            return {'status': 'imports-ready', 'version': installed}
        pipeline = mx = None
        try:
            pipeline, _, mx = self.load_pipeline("generate")
            mx.synchronize()
        except Exception:
            return {'status': 'load-failed', 'version': installed}
        finally:
            pipeline = None
            gc.collect()
            if mx is not None:
                mx.clear_cache()
        return {'status': 'load-ready', 'version': installed}

    def edit(self, request, cancel, progress):
        raise InvalidEditInput('This adapter supports text-to-image generation only.')

    def transform_output(self, image, request):
        return image

    def generate(self, request: dict, cancel: Event, progress) -> dict:
        return self._run(request, cancel, progress, 'generate', request['prompt'], {})

    def _run(self, request, cancel, progress, operation, prompt, conditioning_args):
        if request['model'] != self.capabilities['model']:
            raise InvalidEditInput('The requested model is not configured.')
        sampling, effective = self.sampling(request, operation)
        size = request.get('size', self.capabilities['defaultOutputSize'])
        limits = self.capabilities['size']
        if any(size[axis] < limits.get('min' + axis.title(), limits[axis + 'Multiple'])
               or size[axis] > limits.get('max' + axis.title(), math.inf)
               or size[axis] % limits[axis + 'Multiple']
               for axis in ('width', 'height')):
            raise InvalidEditInput('Output dimensions must match the model geometry.')
        seed = request.get('seed')
        if seed is None:
            seed = secrets.randbits(32)

        def emit(stage, message, completed=None, total=None):
            event = {'type': 'progress', 'verb': operation, 'stage': stage, 'message': message}
            if completed is not None:
                event.update(completed=completed, total=total)
            progress(event)

        pipeline = generated = image = mx = None
        try:
            check_cancelled(cancel)
            emit('loading', 'Loading local image model.')
            pipeline, runtime_version, mx = self.load_pipeline(operation)
            check_cancelled(cancel)
            stage = "editing" if operation == "edit" else "generating"
            pipeline.callbacks.register(StepObserver(cancel, emit, stage))
            emit(stage, 'Running image inference.')
            generated = pipeline.generate_image(seed=seed, prompt=prompt, **sampling, **conditioning_args, **size)
            mx.synchronize()
            check_cancelled(cancel)
            emit('saving', 'Writing image.')
            image = self.transform_output(generated.image, request)
            check_cancelled(cancel)
            # Save pixels only, without MFLUX sidecars, prompt metadata or filename rewriting.
            with open(request['outputPath'], 'xb') as output:
                image.save(output, format='PNG')
            check_cancelled(cancel)
            width, height = image.size
            return {'image': {'path': request['outputPath'], 'mimeType': 'image/png',
                              'size': {'width': width, 'height': height}},
                    'model': request['model'], 'modelRevision': self.config['manifest']['source']['revision'],
                    'runtime': {'name': 'mflux', 'version': runtime_version}, 'seed': seed,
                    'references': request.get('references', []), 'effectiveParameters': effective,
                    **({'loras': lora_provenance(self.config)} if self.config.get('loras') else {})}
        finally:
            # No model retention until measured memory behavior justifies it. Synchronize
            # GPU producers before reporting terminal settlement or releasing private files.
            if mx is not None:
                mx.synchronize()
            generated = pipeline = image = None
            gc.collect()
            if mx is not None:
                mx.clear_cache()
