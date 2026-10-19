# Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
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

import re
import torch

def convert_flux_lora_to_diffusers(old_state_dict):
    new_state_dict = {}
    orig_keys = list(old_state_dict.keys())

    def handle_qkv(sds_sd, ait_sd, sds_key, ait_keys, dims=None):
        down_weight = sds_sd.pop(sds_key)
        up_weight = sds_sd.pop(sds_key.replace(".down.weight", ".up.weight"))

        # calculate dims if not provided
        num_splits = len(ait_keys)
        if dims is None:
            dims = [up_weight.shape[0] // num_splits] * num_splits
        else:
            assert sum(dims) == up_weight.shape[0]

        # make ai-toolkit weight
        ait_down_keys = [k + ".lora_A.weight" for k in ait_keys]
        ait_up_keys = [k + ".lora_B.weight" for k in ait_keys]

        # down_weight is copied to each split
        ait_sd.update({k: down_weight for k in ait_down_keys})

        # up_weight is split to each split
        ait_sd.update({k: v for k, v in zip(ait_up_keys, torch.split(up_weight, dims, dim=0))})  # noqa: C416

    for old_key in orig_keys:
        # Handle double_blocks
        if 'double_blocks' in old_key:
            block_num = re.search(r"double_blocks_(\d+)", old_key).group(1)
            new_key = f"transformer.transformer_blocks.{block_num}"

            if "proj_lora1" in old_key:
                new_key += ".attn.to_out.0"
            elif "proj_lora2" in old_key:
                new_key += ".attn.to_add_out"
            elif "qkv_lora2" in old_key and "up" not in old_key:
                handle_qkv(
                    old_state_dict,
                    new_state_dict,
                    old_key,
                    [
                        f"transformer.transformer_blocks.{block_num}.attn.add_q_proj",
                        f"transformer.transformer_blocks.{block_num}.attn.add_k_proj",
                        f"transformer.transformer_blocks.{block_num}.attn.add_v_proj",
                    ],
                )
                # continue
            elif "qkv_lora1" in old_key and "up" not in old_key:
                handle_qkv(
                    old_state_dict,
                    new_state_dict,
                    old_key,
                    [
                        f"transformer.transformer_blocks.{block_num}.attn.to_q",
                        f"transformer.transformer_blocks.{block_num}.attn.to_k",
                        f"transformer.transformer_blocks.{block_num}.attn.to_v",
                    ],
                )
                # continue

            if "down" in old_key:
                new_key += ".lora_A.weight"
            elif "up" in old_key:
                new_key += ".lora_B.weight"

        # Handle single_blocks
        elif 'single_blocks' in old_key:
            block_num = re.search(r"single_blocks_(\d+)", old_key).group(1)
            new_key = f"transformer.single_transformer_blocks.{block_num}"

            if "proj_lora" in old_key:
                new_key += ".proj_out"
            elif "qkv_lora" in old_key and "up" not in old_key:
                handle_qkv(
                    old_state_dict,
                    new_state_dict,
                    old_key,
                    [
                        f"transformer.single_transformer_blocks.{block_num}.attn.to_q",
                        f"transformer.single_transformer_blocks.{block_num}.attn.to_k",
                        f"transformer.single_transformer_blocks.{block_num}.attn.to_v",
                    ],
                )

            if "down" in old_key:
                new_key += ".lora_A.weight"
            elif "up" in old_key:
                new_key += ".lora_B.weight"

        else:
            # Handle other potential key patterns here
            new_key = old_key

        # Since we already handle qkv above.
        if "qkv" not in old_key and 'embedding' not in old_key:
            new_state_dict[new_key] = old_state_dict.pop(old_key)

    # if len(old_state_dict) > 0:
    #     raise ValueError(f"`old_state_dict` should be at this point but has: {list(old_state_dict.keys())}.")

    return new_state_dict
