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


def test_preparation_verifies_before_publishing_configuration(tmp_path, monkeypatch):
    import json
    import sys
    from types import SimpleNamespace

    cache = tmp_path / 'node_modules/.cache/picpatch-live'
    cache.mkdir(parents=True)
    fixtures = tmp_path / 'tests/fixtures'
    fixtures.mkdir(parents=True)
    bundle = tmp_path / 'bundle'
    bundle.mkdir()
    content = b'fixture'
    weights = bundle / 'weights.safetensors'
    weights.write_bytes(content)
    manifest = {'source': {'repository': 'local', 'revision': 'a' * 40},
                'components': [{'path': weights.name, 'bytes': len(content),
                                'sha256': hashlib.sha256(content).hexdigest()}]}
    (fixtures / 'klein-4b-4bit.manifest.json').write_text(json.dumps(manifest))

    def cached_snapshot(**options):
        assert options['local_files_only'] is True
        return str(bundle)

    monkeypatch.setitem(sys.modules, 'huggingface_hub', SimpleNamespace(snapshot_download=cached_snapshot))
    monkeypatch.setattr(module, '__file__', str(tmp_path / 'scripts/prepare-inference.py'))
    monkeypatch.setattr(sys, 'argv', ['prepare-inference.py', '--offline'])
    module.main()
    config = cache / 'inference-config.json'
    original = config.read_bytes()
    assert json.loads(original)['model']['directory'] == str(bundle)
    weights.write_bytes(b'changed')
    with pytest.raises(ValueError, match='digest'):
        module.main()
    assert config.read_bytes() == original
    assert list(cache.iterdir()) == [config]
