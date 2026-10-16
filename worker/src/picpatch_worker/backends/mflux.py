"""Offline FLUX.2 Klein 4B boundary. Imports no inference libraries until editing."""
import gc
from importlib.metadata import version, PackageNotFoundError
import json
import os
from pathlib import Path
import secrets
from threading import Event


class Cancelled(Exception):
    pass


class InvalidEditInput(Exception):
    pass


class BackendUnavailable(Exception):
    pass


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
    if not paths or request.get('maskImage'):
        raise InvalidEditInput('This adapter requires images and does not support masks.')
    return paths, '\n'.join(descriptions) + '\n\n' + request['instruction']


def load_pipeline(config: dict):
    # Set before importing HF/Transformers: these libraries cache environment settings.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    directory = Path(config['directory'])
    if not directory.is_absolute() or not directory.is_dir():
        raise BackendUnavailable('Supply an existing absolute local model directory.')
    try:
        installed = version('mflux')
    except PackageNotFoundError as error:
        raise BackendUnavailable('Install MFLUX 0.22.0 in the supplied worker environment.') from error
    # This adapter uses an inspected API contract, not a guess at future compatibility.
    if installed != '0.22.0':
        raise BackendUnavailable('This adapter requires MFLUX 0.22.0.')
    ModelConfig, Flux2KleinEdit, mx = import_runtime()
    kwargs = {'model_config': ModelConfig.flux2_klein_4b(), 'model_path': str(directory)}
    if 'quantize' in config:
        kwargs['quantize'] = config['quantize']
    return Flux2KleinEdit(**kwargs), installed, mx


def import_runtime():
    from mflux.models.common.config import ModelConfig
    from mflux.models.flux2.variants import Flux2KleinEdit
    import mlx.core as mx
    return ModelConfig, Flux2KleinEdit, mx


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
    def __init__(self, cancel: Event, emit):
        self.cancel = cancel
        self.emit = emit

    def call_before_loop(self, **kwargs):
        check_cancelled(self.cancel)

    def call_in_loop(self, t, config, **kwargs):
        check_cancelled(self.cancel)
        self.emit('editing', 'Denoising image.', int(t) + 1, int(config.num_inference_steps))

    def call_after_loop(self, **kwargs):
        check_cancelled(self.cancel)


class MfluxAdapter:
    def __init__(self, config: dict):
        self.config = config

    @property
    def capabilities(self) -> dict:
        return {'model': self.config['manifest']['model'], 'instructionEditing': True,
                'referenceRoles': ['subject', 'object', 'style', 'background'],
                'maskMode': 'none', 'size': {'widthMultiple': 16, 'heightMultiple': 16}}

    def edit(self, request: dict, cancel: Event, progress) -> dict:
        if request['model'] != self.capabilities['model']:
            raise InvalidEditInput('The requested model is not configured.')
        paths, prompt = conditioning(request)
        size = request.get('size', {'width': 1024, 'height': 1024})
        if any(value < 16 or value % 16 for value in size.values()):
            raise InvalidEditInput('Output dimensions must be positive multiples of 16.')
        seed = request.get('seed')
        if seed is None:
            seed = secrets.randbits(32)

        def emit(stage, message, completed=None, total=None):
            event = {'type': 'progress', 'verb': 'edit', 'stage': stage, 'message': message}
            if completed is not None:
                event.update(completed=completed, total=total)
            progress(event)

        pipeline = generated = mx = None
        try:
            check_cancelled(cancel)
            emit('loading', 'Loading local editing model.')
            pipeline, runtime_version, mx = load_pipeline(self.config)
            check_cancelled(cancel)
            pipeline.callbacks.register(StepObserver(cancel, emit))
            emit('editing', 'Conditioning references and editing image.')
            generated = pipeline.generate_image(seed=seed, prompt=prompt, image_paths=paths, **size)
            mx.synchronize()
            check_cancelled(cancel)
            emit('saving', 'Writing edited image.')
            # Save pixels only, without MFLUX sidecars, prompt metadata or filename rewriting.
            with open(request['outputPath'], 'xb') as output:
                generated.image.save(output, format='PNG')
            check_cancelled(cancel)
            width, height = generated.image.size
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
            generated = pipeline = None
            gc.collect()
            if mx is not None:
                mx.clear_cache()
