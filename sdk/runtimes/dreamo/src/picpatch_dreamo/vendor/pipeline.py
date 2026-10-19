# Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
# Copyright 2024 Black Forest Labs and The HuggingFace Team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from typing import Any, Callable, Dict, List, Optional, Union

import diffusers
import numpy as np
import torch
import torch.nn as nn
from diffusers import FluxPipeline
from diffusers.pipelines.flux.pipeline_flux import calculate_shift, retrieve_timesteps
from diffusers.pipelines.flux.pipeline_output import FluxPipelineOutput
from einops import repeat
from pathlib import Path
from safetensors.torch import load_file

from .transformer import flux_transformer_forward
from .lora import convert_flux_lora_to_diffusers




def get_task_embedding_idx(task):
    return 0


class DreamOPipeline(FluxPipeline):
    def __init__(self, scheduler, vae, text_encoder, tokenizer, text_encoder_2, tokenizer_2, transformer, image_encoder = None, feature_extractor= None):
        super().__init__(scheduler, vae, text_encoder, tokenizer, text_encoder_2, tokenizer_2, transformer, None, None)
        self.t5_embedding = nn.Embedding(10, 4096)
        self.task_embedding = nn.Embedding(2, 3072)
        self.idx_embedding = nn.Embedding(10, 3072)
        from types import MethodType
        self.transformer.forward = MethodType(flux_transformer_forward, self.transformer)
        self.offload = False
        self.use_nunchaku = False

    def load_dreamo_model(self, directory, device):
        # Modified from DreamO 461e35b: explicit local v1.1 assets only, no Turbo.
        directory = Path(directory)
        dreamo_lora = load_file(str(directory / 'dreamo.safetensors'))
        cfg_lora = load_file(str(directory / 'dreamo_cfg_distill.safetensors'))
        self.t5_embedding.weight.data = dreamo_lora.pop('dreamo_t5_embedding.weight')[-10:]
        self.task_embedding.weight.data = dreamo_lora.pop('dreamo_task_embedding.weight')
        self.idx_embedding.weight.data = dreamo_lora.pop('dreamo_idx_embedding.weight')
        self._prepare_t5()
        weights = [
            ('dreamo', convert_flux_lora_to_diffusers(dreamo_lora), 1),
            ('cfg', convert_flux_lora_to_diffusers(cfg_lora), 1),
            ('sft', load_file(str(directory / 'dreamo_sft_lora.safetensors')), 1),
            ('dpo', load_file(str(directory / 'dreamo_dpo_lora.safetensors')), 1.25),
        ]
        for name, state, _ in weights:
            self.load_lora_weights(state, adapter_name=name)
        names = [name for name, _, _ in weights]
        self.set_adapters(names, [weight for _, _, weight in weights])
        self.fuse_lora(adapter_names=names, lora_scale=1)
        self.unload_lora_weights()
        self.t5_embedding = self.t5_embedding.to(device)
        self.task_embedding = self.task_embedding.to(device)
        self.idx_embedding = self.idx_embedding.to(device)

    def _prepare_t5(self):
        self.text_encoder_2.resize_token_embeddings(len(self.tokenizer_2))
        num_new_token = 10
        new_token_list = [f"[ref#{i}]" for i in range(1, 10)] + ["[res]"]
        self.tokenizer_2.add_tokens(new_token_list, special_tokens=False)
        self.text_encoder_2.resize_token_embeddings(len(self.tokenizer_2))
        input_embedding = self.text_encoder_2.get_input_embeddings().weight.data
        input_embedding[-num_new_token:] = self.t5_embedding.weight.data

    @staticmethod
    def _prepare_latent_image_ids(batch_size, height, width, device, dtype, start_height=0, start_width=0):
        latent_image_ids = torch.zeros(height, width, 3)
        latent_image_ids[..., 1] = latent_image_ids[..., 1] + torch.arange(height)[:, None] + start_height
        latent_image_ids[..., 2] = latent_image_ids[..., 2] + torch.arange(width)[None, :] + start_width

        latent_image_id_height, latent_image_id_width, latent_image_id_channels = latent_image_ids.shape

        latent_image_ids = latent_image_ids[None, :].repeat(batch_size, 1, 1, 1)
        latent_image_ids = latent_image_ids.reshape(
            batch_size, latent_image_id_height * latent_image_id_width, latent_image_id_channels
        )

        return latent_image_ids.to(device=device, dtype=dtype)

    @staticmethod
    def _prepare_style_latent_image_ids(batch_size, height, width, device, dtype, start_height=0, start_width=0):
        latent_image_ids = torch.zeros(height // 2, width // 2, 3)
        latent_image_ids[..., 1] = latent_image_ids[..., 1] + start_height
        latent_image_ids[..., 2] = latent_image_ids[..., 2] + start_width

        latent_image_id_height, latent_image_id_width, latent_image_id_channels = latent_image_ids.shape

        latent_image_ids = latent_image_ids[None, :].repeat(batch_size, 1, 1, 1)
        latent_image_ids = latent_image_ids.reshape(
            batch_size, latent_image_id_height * latent_image_id_width, latent_image_id_channels
        )

        return latent_image_ids.to(device=device, dtype=dtype)

    @torch.no_grad()
    def __call__(
        self,
        prompt: Union[str, List[str]] = None,
        prompt_2: Optional[Union[str, List[str]]] = None,
        negative_prompt: Union[str, List[str]] = None,
        negative_prompt_2: Optional[Union[str, List[str]]] = None,
        true_cfg_scale: float = 1.0,
        true_cfg_start_step: int = 1,
        true_cfg_end_step: int = 1,
        height: Optional[int] = None,
        width: Optional[int] = None,
        num_inference_steps: int = 28,
        sigmas: Optional[List[float]] = None,
        guidance_scale: float = 3.5,
        neg_guidance_scale: float = 3.5,
        num_images_per_prompt: Optional[int] = 1,
        generator: Optional[Union[torch.Generator, List[torch.Generator]]] = None,
        latents: Optional[torch.FloatTensor] = None,
        prompt_embeds: Optional[torch.FloatTensor] = None,
        pooled_prompt_embeds: Optional[torch.FloatTensor] = None,
        negative_prompt_embeds: Optional[torch.FloatTensor] = None,
        negative_pooled_prompt_embeds: Optional[torch.FloatTensor] = None,
        output_type: Optional[str] = "pil",
        return_dict: bool = True,
        joint_attention_kwargs: Optional[Dict[str, Any]] = None,
        callback_on_step_end: Optional[Callable[[int, int, Dict], None]] = None,
        callback_on_step_end_tensor_inputs: List[str] = ["latents"],
        max_sequence_length: int = 512,
        ref_conds=None,
        first_step_guidance_scale=3.5,
    ):
        """Run separately indexed local reference conditioning."""

        height = height or self.default_sample_size * self.vae_scale_factor
        width = width or self.default_sample_size * self.vae_scale_factor

        # 1. Check inputs. Raise error if not correct
        self.check_inputs(
            prompt,
            prompt_2,
            height,
            width,
            prompt_embeds=prompt_embeds,
            pooled_prompt_embeds=pooled_prompt_embeds,
            callback_on_step_end_tensor_inputs=callback_on_step_end_tensor_inputs,
            max_sequence_length=max_sequence_length,
        )

        self._guidance_scale = guidance_scale
        self._joint_attention_kwargs = joint_attention_kwargs
        self._current_timestep = None
        self._interrupt = False

        # 2. Define call parameters
        if prompt is not None and isinstance(prompt, str):
            batch_size = 1
        elif prompt is not None and isinstance(prompt, list):
            batch_size = len(prompt)
        else:
            batch_size = prompt_embeds.shape[0]

        device = self._execution_device

        lora_scale = (
            self.joint_attention_kwargs.get("scale", None) if self.joint_attention_kwargs is not None else None
        )
        has_neg_prompt = negative_prompt is not None or (
            negative_prompt_embeds is not None and negative_pooled_prompt_embeds is not None
        )
        do_true_cfg = true_cfg_scale > 1 and has_neg_prompt
        (
            prompt_embeds,
            pooled_prompt_embeds,
            text_ids,
        ) = self.encode_prompt(
            prompt=prompt,
            prompt_2=prompt_2,
            prompt_embeds=prompt_embeds,
            pooled_prompt_embeds=pooled_prompt_embeds,
            device=device,
            num_images_per_prompt=num_images_per_prompt,
            max_sequence_length=max_sequence_length,
            lora_scale=lora_scale,
        )
        if do_true_cfg:
            (
                negative_prompt_embeds,
                negative_pooled_prompt_embeds,
                _,
            ) = self.encode_prompt(
                prompt=negative_prompt,
                prompt_2=negative_prompt_2,
                prompt_embeds=negative_prompt_embeds,
                pooled_prompt_embeds=negative_pooled_prompt_embeds,
                device=device,
                num_images_per_prompt=num_images_per_prompt,
                max_sequence_length=max_sequence_length,
                lora_scale=lora_scale,
            )

        # 4. Prepare latent variables
        num_channels_latents = self.transformer.config.in_channels // 4
        latents, latent_image_ids = self.prepare_latents(
            batch_size * num_images_per_prompt,
            num_channels_latents,
            height,
            width,
            prompt_embeds.dtype,
            device,
            generator,
            latents,
        )

        # 4.1 concat ref tokens to latent
        origin_img_len = latents.shape[1]
        embeddings = repeat(self.task_embedding.weight[1], "c -> n l c", n=batch_size, l=origin_img_len)
        ref_latents = []
        ref_latent_image_idss = []
        start_height = height // 16
        start_width = width // 16
        for ref_cond in ref_conds:
            img = ref_cond['img']  # [b, 3, h, w], range [-1, 1]
            task = ref_cond['task']
            idx = ref_cond['idx']

            # encode ref with VAE
            img = img.to(latents)
            ref_latent = self.vae.encode(img).latent_dist.sample(generator=generator)
            ref_latent = (ref_latent - self.vae.config.shift_factor) * self.vae.config.scaling_factor
            cur_height = ref_latent.shape[2]
            cur_width = ref_latent.shape[3]
            ref_latent = self._pack_latents(ref_latent, batch_size, num_channels_latents, cur_height, cur_width)
            ref_latent_image_ids = self._prepare_latent_image_ids(
                batch_size, cur_height//2, cur_width//2, device, prompt_embeds.dtype, start_height, start_width
            )
            start_height += cur_height // 2
            start_width += cur_width // 2

            # prepare task_idx_embedding
            task_idx = get_task_embedding_idx(task)
            cur_task_embedding = repeat(
                self.task_embedding.weight[task_idx], "c -> n l c", n=batch_size, l=ref_latent.shape[1]
            )
            cur_idx_embedding = repeat(
                self.idx_embedding.weight[idx], "c -> n l c", n=batch_size, l=ref_latent.shape[1]
            )
            cur_embedding = cur_task_embedding + cur_idx_embedding

            # concat ref to latent
            embeddings = torch.cat([embeddings, cur_embedding], dim=1)
            ref_latents.append(ref_latent)
            ref_latent_image_idss.append(ref_latent_image_ids)

        # 5. Prepare timesteps
        sigmas = np.linspace(1.0, 1 / num_inference_steps, num_inference_steps) if sigmas is None else sigmas
        image_seq_len = latents.shape[1]
        mu = calculate_shift(
            image_seq_len,
            self.scheduler.config.get("base_image_seq_len", 256),
            self.scheduler.config.get("max_image_seq_len", 4096),
            self.scheduler.config.get("base_shift", 0.5),
            self.scheduler.config.get("max_shift", 1.15),
        )
        timesteps, num_inference_steps = retrieve_timesteps(
            self.scheduler,
            num_inference_steps,
            device,
            sigmas=sigmas,
            mu=mu,
        )
        num_warmup_steps = max(len(timesteps) - num_inference_steps * self.scheduler.order, 0)
        self._num_timesteps = len(timesteps)

        # handle guidance
        if self.transformer.config.guidance_embeds:
            guidance = torch.full([1], guidance_scale, device=device, dtype=torch.float32)
            guidance = guidance.expand(latents.shape[0])
        else:
            guidance = None
        neg_guidance = torch.full([1], neg_guidance_scale, device=device, dtype=torch.float32)
        neg_guidance = neg_guidance.expand(latents.shape[0])
        first_step_guidance = torch.full([1], first_step_guidance_scale, device=device, dtype=torch.float32)

        if self.joint_attention_kwargs is None:
            self._joint_attention_kwargs = {}

        # 6. Denoising loop
        with self.progress_bar(total=num_inference_steps) as progress_bar:
            for i, t in enumerate(timesteps):
                if self.interrupt:
                    continue

                self._current_timestep = t
                # broadcast to batch dimension in a way that's compatible with ONNX/Core ML
                timestep = t.expand(latents.shape[0]).to(latents.dtype)

                noise_pred = self.transformer(
                    hidden_states=torch.cat((latents, *ref_latents), dim=1),
                    timestep=timestep / 1000,
                    guidance=guidance if i > 0 else first_step_guidance,
                    pooled_projections=pooled_prompt_embeds,
                    encoder_hidden_states=prompt_embeds,
                    txt_ids=text_ids,
                    img_ids=torch.cat((latent_image_ids, *ref_latent_image_idss), dim=1),
                    joint_attention_kwargs=self.joint_attention_kwargs,
                    return_dict=False,
                    embeddings=embeddings,
                )[0][:, :origin_img_len]

                if do_true_cfg and i >= true_cfg_start_step and i < true_cfg_end_step:
                    neg_noise_pred = self.transformer(
                        hidden_states=latents,
                        timestep=timestep / 1000,
                        guidance=neg_guidance,
                        pooled_projections=negative_pooled_prompt_embeds,
                        encoder_hidden_states=negative_prompt_embeds,
                        txt_ids=text_ids,
                        img_ids=latent_image_ids,
                        joint_attention_kwargs=self.joint_attention_kwargs,
                        return_dict=False,
                    )[0]
                    noise_pred = neg_noise_pred + true_cfg_scale * (noise_pred - neg_noise_pred)

                # compute the previous noisy sample x_t -> x_t-1
                latents_dtype = latents.dtype
                latents = self.scheduler.step(noise_pred, t, latents, return_dict=False)[0]

                if latents.dtype != latents_dtype and torch.backends.mps.is_available():
                    # some platforms (eg. apple mps) misbehave due to a pytorch bug: https://github.com/pytorch/pytorch/pull/99272
                    latents = latents.to(latents_dtype)

                if callback_on_step_end is not None:
                    callback_kwargs = {}
                    for k in callback_on_step_end_tensor_inputs:
                        callback_kwargs[k] = locals()[k]
                    callback_outputs = callback_on_step_end(self, i, t, callback_kwargs)

                    latents = callback_outputs.pop("latents", latents)
                    prompt_embeds = callback_outputs.pop("prompt_embeds", prompt_embeds)

                # call the callback, if provided
                if i == len(timesteps) - 1 or ((i + 1) > num_warmup_steps and (i + 1) % self.scheduler.order == 0):
                    progress_bar.update()

        self._current_timestep = None

        # nunchaku automatic
        if self.offload and not self.use_nunchaku:
            self.transformer.cpu()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        if output_type == "latent":
            image = latents
        else:
            latents = self._unpack_latents(latents, height, width, self.vae_scale_factor)
            latents = (latents / self.vae.config.scaling_factor) + self.vae.config.shift_factor
            image = self.vae.decode(latents, return_dict=False)[0]
            image = self.image_processor.postprocess(image, output_type=output_type)

        # Offload all models
        self.maybe_free_model_hooks()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        if not return_dict:
            return (image,)

        return FluxPipelineOutput(images=image)
