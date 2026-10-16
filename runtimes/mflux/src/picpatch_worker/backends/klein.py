"""Offline FLUX.2 Klein 4B boundary. Imports no inference libraries until editing."""
import gc
from importlib.metadata import version, PackageNotFoundError
import json
import os
from pathlib import Path
import secrets
from threading import Event


from .errors import Cancelled, InvalidEditInput, BackendUnavailable


def check_cancelled(cancel: Event) -> None:
    if cancel.is_set():
        raise Cancelled()


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


def load_pipeline(config: dict, operation="edit"):
    # Set before importing HF/Transformers: these libraries cache environment settings.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    directory = Path(config['directory'])
    if not directory.is_absolute() or not directory.is_dir():
        raise BackendUnavailable('Supply an existing absolute local model directory.', 'missing-directory')
    try:
        installed = version('mflux')
    except PackageNotFoundError as error:
        raise BackendUnavailable('Install MFLUX 0.22.0 in the supplied worker environment.', 'missing-package') from error
    # This adapter uses an inspected API contract, not a guess at future compatibility.
    if installed != '0.22.0':
        raise BackendUnavailable('This adapter requires MFLUX 0.22.0.', 'unsupported-version')
    ModelConfig, pipeline_class, mx = import_runtime(operation)
    kwargs = {'model_config': ModelConfig.flux2_klein_4b(), 'model_path': str(directory)}
    if 'quantize' in config:
        kwargs['quantize'] = config['quantize']
    return pipeline_class(**kwargs), installed, mx


def import_runtime(operation="edit"):
    from mflux.models.common.config import ModelConfig
    from mflux.models.flux2.variants import Flux2KleinEdit
    if operation == "generate":
        from mflux.models.flux2.variants import Flux2Klein
        pipeline_class = Flux2Klein
    else:
        pipeline_class = Flux2KleinEdit
    import mlx.core as mx
    return ModelConfig, pipeline_class, mx


def check_runtime(config: dict, mode: str) -> dict:
    """Authored status only: never forward arbitrary package exception text."""
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    try:
        installed = version('mflux')
    except PackageNotFoundError:
        return {'status': 'missing-package'}
    if installed != '0.22.0':
        return {'status': 'unsupported-version', 'version': installed}
    try:
        import_runtime()
    except ModuleNotFoundError:
        return {'status': 'missing-package', 'version': installed}
    except Exception:
        return {'status': 'import-failed', 'version': installed}
    if mode == 'imports':
        return {'status': 'imports-ready', 'version': installed}
    pipeline = mx = None
    try:
        pipeline, _, mx = load_pipeline(config)
        mx.synchronize()
    except Exception:
        return {'status': 'load-failed', 'version': installed}
    finally:
        pipeline = None
        gc.collect()
        if mx is not None:
            mx.clear_cache()
    return {'status': 'load-ready', 'version': installed}


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


class KleinAdapter:
    def __init__(self, config: dict):
        self.config = config

    def inspect_runtime(self, mode):
        return check_runtime(self.config, mode)

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
            pipeline, runtime_version, mx = load_pipeline(self.config, operation)
            check_cancelled(cancel)
            stage = "editing" if operation == "edit" else "generating"
            pipeline.callbacks.register(StepObserver(cancel, emit, stage))
            emit(stage, 'Running image inference.')
            generated = pipeline.generate_image(seed=seed, prompt=prompt, **conditioning_args, **size)
            mx.synchronize()
            check_cancelled(cancel)
            emit('saving', 'Writing image.')
            image = composite_mask(generated.image, request)
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
