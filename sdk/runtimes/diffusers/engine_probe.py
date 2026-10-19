"""Read-only locked Diffusers dependency/import check; never loads model weights."""
import importlib
import importlib.metadata
import json
import platform
import sys
import tomllib
from pathlib import Path


def main():
    assert sys.version_info[:3] == (3, 15, 0), 'Python version mismatch'
    assert platform.system() == 'Darwin' and platform.machine() == 'arm64', 'Platform mismatch'
    pinned = {item['name']: item['version'] for item in tomllib.loads(Path(sys.argv[1]).read_text())['package']}
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    for distribution in importlib.metadata.distributions():
        name = canonicalize_name(distribution.metadata['Name'])
        assert distribution.version == pinned.get(name), f'Unlocked package: {name}'
        for text in distribution.requires or []:
            requirement = Requirement(text)
            if requirement.marker is None or requirement.marker.evaluate():
                assert importlib.metadata.version(requirement.name) in requirement.specifier, f'Dependency mismatch: {requirement.name}'
    for name in ('torch', 'torchvision', 'diffusers', 'transformers', 'accelerate', 'jsonschema'):
        assert importlib.metadata.version(name) == pinned[name], f'Version mismatch: {name}'
        importlib.import_module(name)
    from diffusers import GlmImagePipeline, Flux2Pipeline
    import torch
    assert torch.backends.mps.is_built(), 'Metal support missing'
    print(json.dumps({'ready': True}))


if __name__ == '__main__':
    main()
