"""Local-only DreamO v1.1 composition with independently indexed subjects.

Full-subject IP conditioning retains clothing as well as facial context. It is
not facial recognition, and one slot cannot silently pool several photographs.
"""
import copy
import gc
import json
import math
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
import secrets

from picpatch_worker_core.errors import BackendUnavailable, Cancelled, InvalidEditInput
from .conditioning import bind_references


def check_cancelled(cancel):
    if cancel.is_set():
        raise Cancelled()


class DreamOAdapter:
    def __init__(self, config):
        if config.get('variant') != 'flux1-dreamo-v1.1' or any(key in config for key in ('quantize', 'loras', 'controlNet', 'photoMaker', 'ipAdapter')):
            raise InvalidEditInput('Unsupported DreamO configuration.')
        self.config = config
        definitions = json.loads(Path(__file__).with_name('models.json').read_text())
        self.definition = next(item for item in definitions if item['id'] == config['variant'])

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
            from .vendor.pipeline import DreamOPipeline
            from .vendor.ben2 import BEN_Base
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

    def directory(self):
        directory = Path(self.config['directory'])
        if not directory.is_absolute() or not directory.is_dir():
            raise BackendUnavailable('Supply an absolute local DreamO bundle.', 'missing-directory')
        return directory

    def load_pipeline(self):
        import torch
        from .vendor.pipeline import DreamOPipeline
        directory = self.directory()
        # No Hub IDs or relative fallbacks, even when a local component is absent.
        pipeline = DreamOPipeline.from_pretrained(str(directory / 'base'), local_files_only=True, torch_dtype=torch.float16)
        pipeline.load_dreamo_model(directory / 'dreamo', 'cpu')
        pipeline.set_progress_bar_config(disable=True)
        pipeline.enable_vae_tiling()
        pipeline.to('mps')
        pipeline.task_embedding = pipeline.task_embedding.to('mps', dtype=torch.float16)
        pipeline.idx_embedding = pipeline.idx_embedding.to('mps', dtype=torch.float16)
        return pipeline

    def prepare_references(self, bindings, cancel):
        import numpy as np
        import torch
        from PIL import Image
        from .vendor.ben2 import BEN_Base
        model = BEN_Base().eval()
        model.loadcheckpoints(str(self.directory() / 'preprocessing' / 'BEN2_Base.pth'))
        model.to('mps')
        conditions = []
        try:
            for binding in bindings:
                check_cancelled(cancel)
                with Image.open(binding['path']) as source:
                    cleaned = model.inference(source.convert('RGB'))
                # Upstream IP preprocessing fits each image to 512² area, in 16px units.
                width, height = cleaned.size
                scale = math.sqrt(512 * 512 / (width * height))
                size = (max(16, int(width * scale) // 16 * 16), max(16, int(height * scale) // 16 * 16))
                import cv2
                rgb = cv2.resize(np.asarray(cleaned), size, interpolation=cv2.INTER_AREA)
                tensor = torch.from_numpy(rgb.copy()).permute(2, 0, 1).unsqueeze(0).float() / 127.5 - 1
                conditions.append({'img': tensor, 'task': 'ip', 'idx': binding['index']})
                check_cancelled(cancel)
        finally:
            torch.mps.synchronize()
            model = None
            self.release()
        return conditions

    @staticmethod
    def release():
        import torch
        if torch.backends.mps.is_available():
            torch.mps.synchronize()
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    def generate(self, request, cancel, progress):
        raise InvalidEditInput('DreamO requires subject or object references.')

    def edit(self, request, cancel, progress):
        if request['model'] != self.capabilities['model']:
            raise InvalidEditInput('The requested model is not configured.')
        bindings, prompt = bind_references(request)
        supplied = request.get('parameters', {})
        if set(supplied) - {'steps', 'guidance'}:
            raise InvalidEditInput('Unsupported DreamO parameter.')
        parameters = {key: value['default'] for key, value in self.capabilities['parameters'].items()}
        parameters.update(supplied)
        for key, value in parameters.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < (1 if key == 'steps' else 0) or (key == 'steps' and (int(value) != value or value > 9007199254740991)):
                raise InvalidEditInput('Invalid DreamO parameter.')
        size = request.get('size', self.capabilities['defaultOutputSize'])
        if any(type(size[axis]) is not int or size[axis] < 16 or size[axis] % 16 for axis in ('width', 'height')):
            raise InvalidEditInput('DreamO dimensions must be multiples of sixteen.')
        seed = request.get('seed', secrets.randbits(32))
        import torch
        if not torch.backends.mps.is_available():
            raise BackendUnavailable('DreamO requires the configured Metal runtime.')
        pipeline = image = conditions = None

        def emit(stage, message, completed=None):
            event = {'type': 'progress', 'verb': 'edit', 'stage': stage, 'message': message}
            if completed is not None:
                event.update(completed=completed, total=parameters['steps'])
            progress(event)

        def step_end(_pipeline, step, _time, kwargs):
            check_cancelled(cancel)
            emit('editing', 'Denoising image.', step + 1)
            return kwargs

        try:
            check_cancelled(cancel)
            emit('loading', 'Preparing local subject references.')
            conditions = self.prepare_references(bindings, cancel)
            check_cancelled(cancel)
            emit('loading', 'Loading local image model.')
            pipeline = self.load_pipeline()
            check_cancelled(cancel)
            emit('editing', 'Running image inference.')
            image = pipeline(prompt=prompt, **size, num_inference_steps=parameters['steps'],
                             guidance_scale=parameters['guidance'], first_step_guidance_scale=parameters['guidance'],
                             ref_conds=conditions, generator=torch.Generator(device='cpu').manual_seed(seed),
                             callback_on_step_end=step_end).images[0]
            torch.mps.synchronize()
            check_cancelled(cancel)
            emit('saving', 'Writing image.')
            with open(request['outputPath'], 'xb') as output:
                # Recreate pixels to discard library prompt/metadata dictionaries.
                from PIL import Image
                Image.frombytes('RGB', image.size, image.convert('RGB').tobytes()).save(output, format='PNG')
            check_cancelled(cancel)
            return {'image': {'path': request['outputPath'], 'mimeType': 'image/png', 'size': {'width': image.width, 'height': image.height}},
                    'model': request['model'], 'modelRevision': self.config['manifest']['source']['revision'],
                    'runtime': {'name': 'dreamo', 'version': '1.1'}, 'seed': seed,
                    'references': request.get('references', []), 'effectiveParameters': parameters}
        finally:
            torch.mps.synchronize()
            pipeline = image = conditions = None
            self.release()
