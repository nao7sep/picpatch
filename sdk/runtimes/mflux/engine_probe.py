"""Read-only dependency/import check for a managed environment; never loads models."""
import importlib
import importlib.metadata
import json
import platform
import sys
import tomllib
from pathlib import Path


def main():
    assert sys.version_info[:3] == (3, 15, 0), "Python version mismatch"
    assert platform.system() == "Darwin" and platform.machine() == "arm64", "Platform mismatch"
    packages = tomllib.loads(Path(sys.argv[1]).read_text())["package"]
    pinned = {p["name"]: p["version"] for p in packages}
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name

    for distribution in importlib.metadata.distributions():
        name = canonicalize_name(distribution.metadata["Name"])
        assert distribution.version == pinned.get(name), f"Unlocked package: {name}"
        for text in distribution.requires or []:
            requirement = Requirement(text)
            if requirement.marker is None or requirement.marker.evaluate():
                version = importlib.metadata.version(requirement.name)
                assert version in requirement.specifier, f"Dependency mismatch: {requirement.name}"
    for name in ("mflux", "mlx", "torch", "jsonschema", "referencing", "transformers"):
        assert importlib.metadata.version(name) == pinned[name], f"Version mismatch: {name}"
    for name in ("mflux", "mlx.core", "torch", "jsonschema", "referencing", "transformers"):
        importlib.import_module(name)
    print(json.dumps({"ready": True}))


if __name__ == "__main__":
    main()
