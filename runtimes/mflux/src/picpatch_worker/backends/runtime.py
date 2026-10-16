"""Shared offline MFLUX loading, inference settlement and pixel-only output."""
import gc
from importlib.metadata import version, PackageNotFoundError
import os
from pathlib import Path
import secrets
from threading import Event


from .errors import Cancelled, InvalidEditInput, BackendUnavailable


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


class MfluxAdapter:
    def __init__(self, config: dict):
        self.config = config

    def load_pipeline(self, operation="generate"):
        # Set before importing HF/Transformers: these libraries cache environment settings.
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
        directory = Path(self.config['directory'])
        if not directory.is_absolute() or not directory.is_dir():
            raise BackendUnavailable('Supply an existing absolute local model directory.', 'missing-directory')
        try:
            installed = version('mflux')
        except PackageNotFoundError as error:
            raise BackendUnavailable('Install MFLUX 0.22.0 in the supplied worker environment.', 'missing-package') from error
        # This adapter uses an inspected API contract, not a guess at future compatibility.
        if installed != '0.22.0':
            raise BackendUnavailable('This adapter requires MFLUX 0.22.0.', 'unsupported-version')
        model_config, pipeline_class, mx = self.import_pipeline(operation)
        kwargs = {'model_config': model_config, 'model_path': str(directory)}
        if 'quantize' in self.config:
            kwargs['quantize'] = self.config['quantize']
        return pipeline_class(**kwargs), installed, mx

    def inspect_runtime(self, mode: str) -> dict:
        """Authored status only: never forward arbitrary package exception text."""
        os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
        try:
            installed = version('mflux')
        except PackageNotFoundError:
            return {'status': 'missing-package'}
        if installed != '0.22.0':
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
        size = request.get('size', self.capabilities['defaultOutputSize'])
        if any(value < 16 or value % 16 for value in size.values()):
            raise InvalidEditInput('Output dimensions must be positive multiples of 16.')
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
            generated = pipeline.generate_image(seed=seed, prompt=prompt, **conditioning_args, **size)
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
                    'references': request.get('references', [])}
        finally:
            # No model retention until measured memory behavior justifies it. Synchronize
            # GPU producers before reporting terminal settlement or releasing private files.
            if mx is not None:
                mx.synchronize()
            generated = pipeline = image = None
            gc.collect()
            if mx is not None:
                mx.clear_cache()
