"""GLM-Image generation and ordered image conditioning, entirely local."""
import copy
import gc
import json
import math
import secrets
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path

from picpatch_worker_core.errors import BackendUnavailable, Cancelled, InvalidEditInput


def check_cancelled(cancel):
    if cancel.is_set():
        raise Cancelled()


def conditioning(request):
    if any(request.get(key) for key in ('maskImage', 'outpaint', 'control')):
        raise InvalidEditInput('GLM-Image does not support masks or structural controls.')
    paths, descriptions = [], []
    if request.get('sourceImage'):
        paths.append(request['sourceImage'])
        descriptions.append('Image 1 is the source image to edit.')
    for group in request.get('references', []):
        if group.get('conditioning', 'appearance') != 'appearance' or group.get('className'):
            raise InvalidEditInput('GLM-Image supports ordered appearance references only.')
        numbers = []
        for path in group['images']:
            paths.append(path)
            numbers.append(str(len(paths)))
        descriptions.append(f"Images {', '.join(numbers)} are {group['role']} references for group {json.dumps(group['id'])}.")
    if not paths:
        raise InvalidEditInput('GLM-Image editing requires at least one conditioning image.')
    return paths, '\n'.join(descriptions) + '\n\n' + request['instruction']


class GlmImageAdapter:
    def __init__(self, config):
        if config.get('variant') != 'glm-image' or any(key in config for key in ('quantize', 'loras', 'controlNet', 'photoMaker', 'ipAdapter')):
            raise InvalidEditInput('Unsupported GLM-Image configuration.')
        self.config = config
        self.definition = next(item for item in json.loads(Path(__file__).with_name('models.json').read_text()) if item['id'] == 'glm-image')

    @property
    def capabilities(self):
        return {**copy.deepcopy(self.definition['capabilities']), 'model': self.config['manifest']['model']}

    def inspect_runtime(self, mode):
        try:
            installed = version('diffusers')
        except PackageNotFoundError:
            return {'status': 'missing-package'}
        if installed != '0.41.0':
            return {'status': 'unsupported-version', 'version': installed}
        try:
            from diffusers import GlmImagePipeline
        except ModuleNotFoundError:
            return {'status': 'missing-package', 'version': installed}
        except Exception:
            return {'status': 'import-failed', 'version': installed}
        if mode == 'imports':
            return {'status': 'imports-ready', 'version': installed}
        pipeline = None
        try:
            pipeline = self.load_pipeline()
        except Exception:
            return {'status': 'load-failed', 'version': installed}
        finally:
            pipeline = None
            self.release()
        return {'status': 'load-ready', 'version': installed}

    def load_pipeline(self):
        import torch
        from diffusers import GlmImagePipeline
        directory = Path(self.config['directory'])
        if not directory.is_absolute() or not directory.is_dir():
            raise BackendUnavailable('Supply an absolute local GLM-Image directory.', 'missing-directory')
        pipeline = GlmImagePipeline.from_pretrained(str(directory), local_files_only=True, torch_dtype=torch.bfloat16)
        pipeline.set_progress_bar_config(disable=True)
        pipeline.vae.enable_tiling()
        return pipeline.to('mps')

    @staticmethod
    def release():
        import torch
        if torch.backends.mps.is_available():
            torch.mps.synchronize()
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    def generate(self, request, cancel, progress):
        return self._run(request, cancel, progress, 'generate', request['prompt'], [])

    def edit(self, request, cancel, progress):
        paths, prompt = conditioning(request)
        return self._run(request, cancel, progress, 'edit', prompt, paths)

    def _run(self, request, cancel, progress, operation, prompt, paths):
        if request['model'] != self.capabilities['model']:
            raise InvalidEditInput('The requested model is not configured.')
        supplied = request.get('parameters', {})
        if set(supplied) - {'steps', 'guidance'}:
            raise InvalidEditInput('Unsupported GLM-Image parameter.')
        parameters = {key: value['default'] for key, value in self.capabilities['parameters'].items()}
        parameters.update(supplied)
        for key, value in parameters.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < (1 if key == 'steps' else 0) or (key == 'steps' and (int(value) != value or value > 9007199254740991)):
                raise InvalidEditInput('Invalid GLM-Image parameter.')
        size = request.get('size', self.capabilities['defaultOutputSize'])
        if any(type(size[axis]) is not int or size[axis] < 32 or size[axis] % 32 for axis in ('width', 'height')):
            raise InvalidEditInput('GLM-Image dimensions must be multiples of thirty-two.')
        seed = request.get('seed', secrets.randbits(32))
        import torch
        from PIL import Image
        if not torch.backends.mps.is_available():
            raise BackendUnavailable('GLM-Image requires the configured Metal runtime.')
        pipeline = image = None
        images = []
        handle = None

        def emit(stage, message, completed=None):
            event = {'type': 'progress', 'verb': operation, 'stage': stage, 'message': message}
            if completed is not None:
                event.update(completed=completed, total=parameters['steps'])
            progress(event)

        def step_end(_pipeline, step, _time, kwargs):
            check_cancelled(cancel)
            emit('generating' if operation == 'generate' else 'editing', 'Denoising image.', step + 1)
            return kwargs

        try:
            check_cancelled(cancel)
            emit('loading', 'Loading local image model.')
            pipeline = self.load_pipeline()
            check_cancelled(cancel)
            for path in paths:
                with Image.open(path) as source:
                    images.append(source.convert('RGB'))
            # The public diffusion callback does not cover the autoregressive prior.
            # A per-instance pre-hook stops at each token forward without changing
            # Transformers globals or pretending an executing kernel is cancelled.
            handle = pipeline.vision_language_encoder.register_forward_pre_hook(lambda *_args: check_cancelled(cancel))
            emit('generating' if operation == 'generate' else 'editing', 'Running image inference.')
            image = pipeline(prompt=prompt, image=images or None, **size,
                             num_inference_steps=parameters['steps'], guidance_scale=parameters['guidance'],
                             generator=torch.Generator(device='cpu').manual_seed(seed),
                             callback_on_step_end=step_end).images[0]
            torch.mps.synchronize()
            check_cancelled(cancel)
            emit('saving', 'Writing image.')
            with open(request['outputPath'], 'xb') as output:
                Image.frombytes('RGB', image.size, image.convert('RGB').tobytes()).save(output, format='PNG')
            check_cancelled(cancel)
            return {'image': {'path': request['outputPath'], 'mimeType': 'image/png', 'size': {'width': image.width, 'height': image.height}},
                    'model': request['model'], 'modelRevision': self.config['manifest']['source']['revision'],
                    'runtime': {'name': 'diffusers', 'version': '0.41.0'}, 'seed': seed,
                    'references': request.get('references', []), 'effectiveParameters': parameters}
        finally:
            if handle is not None:
                handle.remove()
            for reference in images:
                reference.close()
            pipeline = image = None
            self.release()
