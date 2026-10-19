"""Exercise actual DreamO reference routing and sampling without trained weights."""
import socket
import torch
from diffusers import AutoencoderKL, FluxTransformer2DModel, FlowMatchEulerDiscreteScheduler
from picpatch_dreamo.vendor.pipeline import DreamOPipeline
from picpatch_dreamo.vendor.ben2 import BEN_Base
from picpatch_dreamo.adapter import DreamOAdapter


def denied(*_args, **_kwargs):
    raise AssertionError('Runtime probe attempted network access.')

socket.socket.connect = denied
socket.getaddrinfo = denied
original_forward = FluxTransformer2DModel.forward
torch.manual_seed(24)
transformer = FluxTransformer2DModel(in_channels=4, num_layers=1, num_single_layers=1,
    attention_head_dim=8, num_attention_heads=2, joint_attention_dim=16,
    pooled_projection_dim=8, axes_dims_rope=(2, 2, 4), guidance_embeds=True)
vae = AutoencoderKL(block_out_channels=(8,), latent_channels=1, norm_num_groups=4,
    shift_factor=0.1, scaling_factor=0.3)
pipeline = DreamOPipeline(FlowMatchEulerDiscreteScheduler(), vae, None, None, None, None, transformer)
pipeline.task_embedding = torch.nn.Embedding(2, 16)
pipeline.idx_embedding = torch.nn.Embedding(10, 16)
pipeline.set_progress_bar_config(disable=True)
assert FluxTransformer2DModel.forward is original_forward, 'Pipeline modified global Diffusers behavior.'

refs = [torch.randn(1, 3, 16, 16), torch.randn(1, 3, 16, 16)]
text, pooled = torch.randn(1, 3, 16), torch.randn(1, 8)
for device in ('cpu', 'mps'):
    dtype = torch.float16 if device == 'mps' else torch.float32
    pipeline.to(device, dtype=dtype)
    pipeline.task_embedding.to(device, dtype=dtype)
    pipeline.idx_embedding.to(device, dtype=dtype)
    # Upstream accesses .weight directly, so observe the transformer inputs instead.
    observed = []
    handle = transformer.register_forward_pre_hook(lambda _m, _args, kwargs: observed.append(kwargs['embeddings'].detach().cpu()), with_kwargs=True)
    def run(order=(1, 2), callback=None, output_type='latent'):
        return pipeline(prompt_embeds=text.to(device, dtype=dtype), pooled_prompt_embeds=pooled.to(device, dtype=dtype),
            height=16, width=16, num_inference_steps=2,
            ref_conds=[{'img': image, 'task': 'ip', 'idx': idx} for image, idx in zip(refs, order)],
            generator=torch.Generator(device='cpu').manual_seed(14), callback_on_step_end=callback,
            output_type=output_type).images
    first = run().detach().cpu()
    repeated = run().detach().cpu()
    swapped = run((2, 1)).detach().cpu()
    assert torch.equal(first, repeated), 'Reference VAE sampling ignored caller seed.'
    assert not torch.equal(first, swapped), 'Independent reference indices had no effect.'
    # 16² source at VAE scale 1 is packed into 64 tokens; refs have the same shape.
    for embeddings in observed:
        assert torch.equal(embeddings[:, 64:128], (pipeline.task_embedding.weight[0] + pipeline.idx_embedding.weight[1]).detach().cpu().expand(1, 64, 16)) or torch.equal(embeddings[:, 64:128], (pipeline.task_embedding.weight[0] + pipeline.idx_embedding.weight[2]).detach().cpu().expand(1, 64, 16))
    image = run(output_type='pil')[0]
    assert image.size == (16, 16)
    class Stopped(Exception): pass
    steps = []
    def cancel(_pipeline, step, _time, _kwargs):
        steps.append(step)
        raise Stopped()
    try:
        run(callback=cancel)
        raise AssertionError('Cancellation did not interrupt inference.')
    except Stopped:
        assert steps == [0]
    handle.remove()

status = DreamOAdapter({'variant': 'flux1-dreamo-v1.1', 'manifest': {'model': 'fixture'}}).inspect_runtime('imports')
assert status['status'] == 'imports-ready'
print('DreamO imports, CPU/Metal inference, seeded references, independent indices and cancellation passed.')
