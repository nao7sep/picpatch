"""The explicit preparation tool rejects corrupt cached files before configuration publication."""
import hashlib
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('prepare_inference', Path(__file__).resolve().parents[3] / 'scripts/prepare-inference.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_component_verification_checks_content_not_only_size(tmp_path):
    content = b'fixture'
    path = tmp_path / 'weights.safetensors'
    path.write_bytes(content)
    manifest = {'components': [{'path': path.name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}]}
    module.verify_files(tmp_path, manifest)
    path.write_bytes(b'changed')
    with pytest.raises(ValueError, match='digest'):
        module.verify_files(tmp_path, manifest)
    path.write_bytes(b'')
    with pytest.raises(ValueError, match='size'):
        module.verify_files(tmp_path, manifest)
    path.unlink()
    with pytest.raises(FileNotFoundError):
        module.verify_files(tmp_path, manifest)
