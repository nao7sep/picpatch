"""Exercise real FLUX.2 diffusion, ordered image latents and decode without weights."""
import socket
import tempfile
from unittest.mock import patch
from picpatch_diffusers.flux2 import Flux2Adapter
import torch
from PIL import Image
from diffusers import AutoencoderKLFlux2, Flux2Transformer2DModel, FlowMatchEulerDiscreteScheduler, Flux2Pipeline


def denied(*_args, **_kwargs):
    raise AssertionError('Runtime probe attempted network access.')


socket.socket.connect = denied
socket.getaddrinfo = denied
torch.manual_seed(24)
transformer = Flux2Transformer2DModel(in_channels=4, num_layers=1, num_single_layers=1,
    attention_head_dim=8, num_attention_heads=2, joint_attention_dim=16,
    axes_dims_rope=(2, 2, 2, 2))
vae = AutoencoderKLFlux2(block_out_channels=(8, 8, 8, 8), down_block_types=("DownEncoderBlock2D",) * 4, up_block_types=("UpDecoderBlock2D",) * 4, latent_channels=1, norm_num_groups=4)
pipeline = Flux2Pipeline(FlowMatchEulerDiscreteScheduler(), vae, None, None, transformer)
pipeline.set_progress_bar_config(disable=True)
# Persist actual tiny components and exercise the production loader/setup.
# Text encoding remains unqualified: this fixture supplies embeddings.
with tempfile.TemporaryDirectory() as directory:
    pipeline.save_pretrained(directory)
    adapter = Flux2Adapter({'variant': 'flux2-dev', 'directory': directory, 'manifest': {'model': 'fixture'}})
    original_loader = Flux2Pipeline.from_pretrained
    # Only omit the unqualified text components; actual diffusion loading runs.
    with patch.object(Flux2Pipeline, "from_pretrained", side_effect=lambda *args, **kwargs: original_loader(*args, **kwargs, text_encoder=None, tokenizer=None)):
        pipeline = adapter.load_pipeline()
    assert pipeline.vae.use_tiling
text = torch.randn(1, 3, 16)
references = [Image.new('RGB', (64, 64), 'red'), Image.new('RGB', (64, 64), 'blue')]
for device in ('cpu', 'mps'):
    dtype = torch.bfloat16 if device == 'mps' else torch.float32
    pipeline.to(device, dtype=dtype)
    def run(images=None, callback=None):
        return pipeline(prompt_embeds=text.to(device, dtype=dtype), image=images,
            height=64, width=64, num_inference_steps=2,
            generator=torch.Generator(device='cpu').manual_seed(14), callback_on_step_end=callback).images[0]
    generated = run()
    edited = run(references)
    repeated = run(references)
    assert generated.size == edited.size == (64, 64)
    assert edited.tobytes() == repeated.tobytes(), 'Reference sampling ignored caller seed.'
    assert generated.tobytes() != edited.tobytes(), 'References had no effect.'
    class Stopped(Exception):
        pass
    steps = []
    def cancel(_pipeline, step, _time, _kwargs):
        steps.append(step)
        raise Stopped()
    try:
        run(references, callback=cancel)
        raise AssertionError('Cancellation did not interrupt inference.')
    except Stopped:
        assert steps == [0]
print('FLUX.2 CPU/Metal generation, ordered references, seeded sampling and cancellation passed.')
