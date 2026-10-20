"""Read-only check that a managed environment matches its lock and imports; never loads models.

Usage: engine_probe.py LOCK PYTHON_VERSION MODULE... [--metal]
A MODULE may name an attribute as module:attribute. --metal requires PyTorch's Metal backend.
"""
import importlib
import importlib.metadata
import json
import platform
import sys
import tomllib
from pathlib import Path


def main(arguments):
    metal = '--metal' in arguments
    lock, python, *modules = [argument for argument in arguments if argument != '--metal']
    assert sys.version_info[:3] == tuple(int(part) for part in python.split('.')), 'Python version mismatch'
    assert platform.system() == 'Darwin' and platform.machine() == 'arm64', 'Platform mismatch'
    pinned = {item['name']: item['version'] for item in tomllib.loads(Path(lock).read_text())['package']}
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    # Every installed distribution is the locked version, so a named package is the pinned one once it imports.
    for distribution in importlib.metadata.distributions():
        name = canonicalize_name(distribution.metadata['Name'])
        assert distribution.version == pinned.get(name), f'Unlocked package: {name}'
        for text in distribution.requires or []:
            requirement = Requirement(text)
            if requirement.marker is None or requirement.marker.evaluate():
                assert importlib.metadata.version(requirement.name) in requirement.specifier, f'Dependency mismatch: {requirement.name}'
    for name in modules:
        module, _, attribute = name.partition(':')
        imported = importlib.import_module(module)
        if attribute:
            getattr(imported, attribute)
    if metal:
        import torch
        assert torch.backends.mps.is_built(), 'Metal support missing'
    print(json.dumps({'ready': True}))


if __name__ == '__main__':
    main(sys.argv[1:])
