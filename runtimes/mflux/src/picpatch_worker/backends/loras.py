"""Local LoRA admission and pinned MFLUX mapping, without downloading or baking."""
import importlib
import math
from pathlib import Path, PurePosixPath
from .errors import InvalidEditInput

MAPPINGS = {
    'flux2-klein': ('flux2', 'flux2_lora_mapping', 'Flux2LoRAMapping'),
    'flux1': ('flux', 'flux_lora_mapping', 'FluxLoRAMapping'),
    'flux1-fill': ('flux', 'flux_lora_mapping', 'FluxLoRAMapping'),
    'flux1-kontext': ('flux', 'flux_lora_mapping', 'FluxLoRAMapping'),
    'z-image': ('z_image', 'z_image_lora_mapping', 'ZImageLoRAMapping'),
    'ernie-image': ('ernie_image', 'ernie_lora_mapping', 'ErnieLoRAMapping'),
    'qwen-image': ('qwen', 'qwen_lora_mapping', 'QwenLoRAMapping'),
    'qwen-edit': ('qwen', 'qwen_lora_mapping', 'QwenLoRAMapping'),
    'qwen21': ('qwen21', 'qwen21_lora_mapping', 'Qwen21LoRAMapping'),
}


def validate_selection(config):
    if 'loras' not in config:
        return
    loras = config['loras']
    if not isinstance(loras, list) or not loras:
        raise InvalidEditInput('Supply a nonempty local LoRA selection.')
    seen = set()
    components = config.get('manifest', {}).get('components', [])
    for lora in loras:
        if not isinstance(lora, dict) or set(lora) - {'path', 'scale'}:
            raise InvalidEditInput('Invalid LoRA selection.')
        path = lora.get('path')
        scale = lora.get('scale', 1)
        if (not isinstance(path, str) or not path or PurePosixPath(path).is_absolute()
                or any(part in ('', '.', '..') for part in path.split('/'))
                or any(ord(char) < 32 or ord(char) == 127 or char in '\\:' for char in path)
                or not path.lower().endswith('.safetensors') or path.lower() in seen
                or isinstance(scale, bool) or not isinstance(scale, (int, float))
                or not math.isfinite(scale) or abs(scale) > 3.4028234663852886e38
                or not any(item.get('path') == path and item.get('role') == 'weights' for item in components)):
            raise InvalidEditInput('LoRAs require unique declared safetensors paths and finite scales.')
        seen.add(path.lower())


def lora_kwargs(config, family):
    if not config.get('loras'):
        return {}
    # Imports remain lazy: protocol handshakes need no inference packages.
    from safetensors import safe_open
    from mflux.models.common.lora.mapping.lora_loader import LoRALoader
    package, module, name = MAPPINGS[family]
    mapping = getattr(importlib.import_module(f'mflux.models.{package}.weights.{module}'), name).get_mapping()
    patterns = [item for item in LoRALoader._build_pattern_mappings(mapping) if item.matrix_name in ('lora_A', 'lora_B', 'alpha')]
    paths = []
    for lora in config['loras']:
        path = Path(config['directory']) / lora['path']
        try:
            # Prevent MFLUX's path resolver from interpreting a missing file as a remote selection.
            if not path.is_file():
                raise InvalidEditInput('Local LoRA file is missing.')
            with safe_open(str(path), framework='numpy') as weights:
                keys = list(weights.keys())
                if not keys or any(not any(LoRALoader._match_pattern(key, item.source_pattern) is not None for item in patterns) for key in keys):
                    raise InvalidEditInput('LoRA contains tensors unsupported by the selected MFLUX family.')
        except InvalidEditInput:
            raise
        except Exception as error:
            raise InvalidEditInput('Could not read local LoRA safetensors.') from error
        paths.append(str(path))
    return {'lora_paths': paths, 'lora_scales': [item.get('scale', 1) for item in config['loras']], 'bake_lora': False}


def lora_provenance(config):
    return [{'filename': PurePosixPath(item['path']).name, 'scale': item.get('scale', 1),
             'sha256': next(component['sha256'] for component in config['manifest']['components'] if component['path'] == item['path'])}
            for item in config['loras']]


def validate_loaded_loras(pipeline):
    """Unbaked MFLUX replaces matrices without checking their base-layer dimensions."""
    from mlx import nn
    from mflux.models.common.lora.layer.linear_lora_layer import LoRALinear
    count = 0
    for _, layer in pipeline.transformer.named_modules():
        if not isinstance(layer, LoRALinear):
            continue
        count += 1
        output_dims, input_dims = layer.linear.weight.shape
        if isinstance(layer.linear, nn.QuantizedLinear):
            input_dims *= 32 // layer.linear.bits
        a, b = layer.lora_A.shape, layer.lora_B.shape
        if len(a) != 2 or len(b) != 2 or a[0] != input_dims or b[1] != output_dims or a[1] != b[0] or a[1] <= 0:
            raise InvalidEditInput('LoRA dimensions do not match the selected model.')
    if not count:
        raise InvalidEditInput('No supported LoRA layers were loaded.')
