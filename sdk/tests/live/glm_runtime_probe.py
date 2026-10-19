"""Stock GLM denoising/ordered-image cache with tiny random tensors, not trained inference."""
import socket
from PIL import Image
import torch
from diffusers import GlmImagePipeline, GlmImageTransformer2DModel, AutoencoderKL, FlowMatchEulerDiscreteScheduler


def denied(*_args, **_kwargs):
    raise AssertionError('Runtime probe attempted network access.')


socket.socket.connect = denied
socket.getaddrinfo = denied
torch.manual_seed(42)
pipeline = GlmImagePipeline(
    None, None, None, None,
    AutoencoderKL(block_out_channels=(8,), latent_channels=4, norm_num_groups=4,
                  latents_mean=[0, 0, 0, 0], latents_std=[1, 1, 1, 1]),
    GlmImageTransformer2DModel(in_channels=4, out_channels=4, num_layers=1,
        attention_head_dim=8, num_attention_heads=2, text_embed_dim=16,
        time_embed_dim=16, condition_dim=8, prior_vq_quantizer_codebook_size=32),
    FlowMatchEulerDiscreteScheduler(),
)
pipeline.set_progress_bar_config(disable=True)
# Keep the real pipeline/VAE here: a loader-only double still catches integration
# calls to methods that the selected pipeline does not actually expose.
from tempfile import TemporaryDirectory
from unittest.mock import patch
from picpatch_diffusers.glm import GlmImageAdapter
with TemporaryDirectory() as directory:
    adapter = GlmImageAdapter({'variant': 'glm-image', 'directory': directory, 'manifest': {'model': 'tiny'}})
    with patch.object(GlmImagePipeline, 'from_pretrained', return_value=pipeline) as loader:
        assert adapter.load_pipeline() is pipeline
        loader.assert_called_once_with(directory, local_files_only=True, torch_dtype=torch.bfloat16)
for device in ('cpu', 'mps'):
    pipeline.to(device, dtype=torch.bfloat16 if device == 'mps' else torch.float32)
    arguments = dict(
        prompt_embeds=torch.randn(1, 4, 16, device=device, dtype=pipeline.transformer.dtype),
        negative_prompt_embeds=torch.zeros(1, 4, 16, device=device, dtype=pipeline.transformer.dtype),
        prior_token_ids=torch.zeros(1, 16, dtype=torch.long, device=device),
        height=8, width=8, num_inference_steps=2,
        generator=torch.Generator().manual_seed(1),
    )
    assert pipeline(**arguments).images[0].size == (8, 8)
    arguments.update(
        image=[Image.new('RGB', (8, 8), 'red'), Image.new('RGB', (8, 8), 'blue')],
        prior_token_image_ids=[torch.zeros(32, dtype=torch.long, device=device)],
        source_image_grid_thw=[torch.tensor([[1, 4, 4], [1, 4, 4]], device=device)],
    )
    assert pipeline(**arguments).images[0].size == (8, 8)

    class Stopped(Exception):
        pass

    def stop(*_args):
        raise Stopped()

    try:
        pipeline(**arguments, callback_on_step_end=stop)
        raise AssertionError('Cancellation did not interrupt denoising.')
    except Stopped:
        pass

# Exercise real autoregressive sampling separately with a tiny vocabulary.
# This does not claim tokenizer/processor or trained bundle compatibility.
from threading import Event
from transformers import GlmImageConfig, GlmImageForConditionalGeneration
from picpatch_diffusers.glm import check_cancelled
from picpatch_worker_core.errors import Cancelled

encoder = GlmImageForConditionalGeneration(GlmImageConfig(
    text_config=dict(vocab_size=64, hidden_size=32, intermediate_size=64,
        num_hidden_layers=1, num_attention_heads=4, num_key_value_heads=2,
        vision_vocab_size=32, pad_token_id=0, eos_token_id=31,
        rope_parameters={'rope_type': 'default', 'mrope_section': [1, 1, 2]}),
    vision_config=dict(depth=1, hidden_size=16, num_heads=2, image_size=32,
        patch_size=4, intermediate_size=32),
    vq_config=dict(embed_dim=16, num_embeddings=32, latent_channels=16),
    image_token_id=60, image_start_token_id=29, image_end_token_id=31,
))
for device in ('cpu', 'mps'):
    encoder.to(device, dtype=torch.bfloat16 if device == 'mps' else torch.float32)
    arguments = dict(input_ids=torch.tensor([[1, 2, 3]], device=device), max_new_tokens=2, do_sample=True)
    torch.manual_seed(19)
    first = encoder.generate(**arguments)
    torch.manual_seed(19)
    assert torch.equal(first, encoder.generate(**arguments))
    cancel = Event()
    cancel.set()
    handle = encoder.register_forward_pre_hook(lambda *_args: check_cancelled(cancel))
    try:
        encoder.generate(**arguments)
        raise AssertionError('Autoregressive cancellation did not interrupt inference.')
    except Cancelled:
        pass
    finally:
        handle.remove()

print('GLM CPU/Metal generation, two-reference cache and cancellation passed; tiny autoregressive seed/cancellation passed; trained bundle not exercised.')
