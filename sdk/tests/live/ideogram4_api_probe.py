"""Actual MFLUX scheduling and MLX arithmetic, substituting only trained components."""
import inspect
import json
import tempfile
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

import mlx.core as mx
from mflux.callbacks.callback_registry import CallbackRegistry
from mflux.models.common.weights.loading.weight_loader import WeightLoader
from mflux.models.ideogram4.latent_creator import Ideogram4LatentCreator
from mflux.models.ideogram4.model.ideogram4_text_encoder import Ideogram4PromptEncoder
from mflux.models.ideogram4.variants.txt2img.ideogram4 import Ideogram4
from mflux.models.ideogram4.weights import Ideogram4WeightDefinition
from mflux.utils.image_util import ImageUtil
from picpatch_worker.backends import create_adapter
from picpatch_worker.backends.runtime import StepObserver
from picpatch_worker.backends.errors import Cancelled

adapter = create_adapter({'variant': 'ideogram4-fp8', 'manifest': {'model': 'fixture'}})
model_config, pipeline, _ = adapter.import_pipeline('generate')
assert pipeline is Ideogram4
assert {'model_config', 'model_path', 'quantize'} <= inspect.signature(pipeline.__init__).parameters.keys()
assert {'seed', 'prompt', 'width', 'height', 'num_inference_steps', 'guidance'} <= inspect.signature(pipeline.generate_image).parameters.keys()
components = {component.hf_subdir for component in Ideogram4WeightDefinition.get_components()}
assert components == {'vae', 'transformer', 'unconditional_transformer', 'text_encoder'}
assert Ideogram4WeightDefinition.get_tokenizers()[0].hf_subdir == 'tokenizer'
assert Ideogram4LatentCreator.MIN_DIMENSION == 256
assert Ideogram4LatentCreator.MAX_DIMENSION == 2048
assert Ideogram4LatentCreator.DIMENSION_STEP == 16
assert Ideogram4PromptEncoder.resolve_prompt('A ceramic bowl.', strict_caption_validation=False, warn_on_caption_issues=False) == 'A ceramic bowl.'
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    for part in components:
        (root / part).mkdir()
    (root / 'text_encoder/config.json').write_text(json.dumps({'ideogram_fp8_weight_only': True}))
    assert Ideogram4WeightDefinition.validate_fp8_checkpoint(root) == root
    seen = set()
    def read_component(root_path, component, cache, save_subdir):
        assert root_path.resolve() == root.resolve()
        seen.add(component.hf_subdir)
        return {}, None, None
    with patch.object(WeightLoader, '_load_component', side_effect=read_component):
        WeightLoader.load(weight_definition=Ideogram4WeightDefinition, model_path=directory)
    assert seen == components

# The real generation loop selects a fixed scalar when steps are explicit.
# Tiny deterministic predictions replace the two learned transformer forwards.
class Harness:
    model_config = model_config
    tokenizers = {'ideogram4': object()}
    text_encoder = object()
    prompt_cache = {}
    conditional_transformer = SimpleNamespace(config=SimpleNamespace(in_channels=128))
    unconditional_transformer = object()
    bits = None
    lora_paths = lora_scales = None
    def __init__(self):
        self.callbacks = CallbackRegistry()
        self.guidance = []
    def _predict_conditional(self, transformer):
        return lambda **kwargs: mx.ones_like(kwargs['z'])
    def _predict_unconditional(self, transformer):
        return lambda **kwargs: mx.zeros_like(kwargs['z'])
    def _denoise_step(self, **kwargs):
        self.guidance.append(kwargs['guidance_value'])
        return Ideogram4._denoise_step(self, **kwargs)
    def _decode_latents(self, **kwargs):
        mx.eval(kwargs['z'])
        assert bool(mx.all(mx.isfinite(kwargs['z'])))
        return kwargs['z']

cancel = Event()
progress = []
harness = Harness()
harness.callbacks.register(StepObserver(cancel, lambda *args: progress.append(args), 'generating'))
with patch.object(Ideogram4PromptEncoder, 'build_inputs', return_value={'max_text_tokens': 1}), \
     patch.object(Ideogram4PromptEncoder, 'encode_prompt', return_value=mx.zeros((1, 1, 1))), \
     patch.object(Ideogram4PromptEncoder, 'negative_inputs', return_value={}), \
     patch.object(ImageUtil, 'to_image', side_effect=lambda **kwargs: kwargs):
    sampling, effective = adapter.sampling({'parameters': {'steps': 3, 'guidance': 5}}, 'generate')
    result = Ideogram4.generate_image(harness, seed=0, prompt='A ceramic bowl.', width=256, height=256,
                                     warn_on_caption_issues=False, **sampling)
    assert harness.guidance == [5, 5, 5]
    assert effective == {'steps': 3, 'guidance': 5}
    assert len(progress) == 3
    assert result['seed'] == 0
    cancel.set()
    try:
        Ideogram4.generate_image(harness, seed=0, prompt='A ceramic bowl.', width=256, height=256,
                                 warn_on_caption_issues=False, **sampling)
    except Cancelled:
        pass
    else:
        raise AssertionError('Actual loop did not check cancellation')
mx.synchronize()
mx.clear_cache()
