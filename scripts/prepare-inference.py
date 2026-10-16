"""Explicitly acquire the pinned test model using an already installed inference runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def verify_files(directory: Path, manifest: dict) -> None:
    for component in manifest['components']:
        path = directory / component['path']
        if path.stat().st_size != component['bytes']:
            raise ValueError(f"Wrong size for {component['path']}")
        with path.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != component['sha256']:
            raise ValueError(f"Wrong digest for {component['path']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='Use cached files only; fail if incomplete.')
    args = parser.parse_args()
    # An explicit development tool, never imported by the SDK or invoked by tests.
    from huggingface_hub import snapshot_download
    root = Path(__file__).resolve().parents[1]
    cache = root / 'node_modules/.cache/picpatch-live'
    manifest = json.loads((root / 'tests/fixtures/klein-4b-4bit.manifest.json').read_text())
    directory = snapshot_download(
        repo_id=manifest['source']['repository'], revision=manifest['source']['revision'],
        allow_patterns=[item['path'] for item in manifest['components']],
        cache_dir=cache / 'huggingface', local_files_only=args.offline, max_workers=2,
    )
    verify_files(Path(directory), manifest)
    config = {'pythonExecutable': sys.executable, 'model': {
        'adapter': 'mflux-flux2-klein-4b', 'directory': directory, 'manifest': manifest,
    }}
    # Publish a complete configuration only after every component matches its pin.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=cache, delete=False) as file:
            temporary = Path(file.name)
            json.dump(config, file, indent=2)
            file.write('\n')
        os.replace(temporary, cache / 'inference-config.json')
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print('Verified the pinned model and prepared the local inference test configuration.')


if __name__ == '__main__':
    main()
