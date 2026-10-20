"""The release each adapter states matches what its runtime's lock pins."""
import ast
import json
import tomllib
from pathlib import Path

RUNTIMES = Path(__file__).resolve().parents[3] / 'runtimes'


def constant(path, name):
    """A module-level constant, read from the adapter's source without importing its runtime packages."""
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f'{name} is not defined in {path.name}')


def pinned(runtime, package):
    extra = tomllib.loads((RUNTIMES / runtime / 'pyproject.toml').read_text())['project']['optional-dependencies']['inference']
    return next(requirement.split('==')[1] for requirement in extra if requirement.startswith(f'{package}=='))


def test_adapters_state_the_pinned_releases():
    assert constant(RUNTIMES / 'mflux/src/picpatch_worker/backends/runtime.py', 'MFLUX_VERSION') == pinned('mflux', 'mflux')
    for adapter in ('glm.py', 'flux2.py'):
        assert constant(RUNTIMES / 'diffusers/src/picpatch_diffusers' / adapter, 'DIFFUSERS_VERSION') == pinned('diffusers', 'diffusers')
    adapter = RUNTIMES / 'dreamo/src/picpatch_dreamo/adapter.py'
    assert constant(adapter, 'DIFFUSERS_VERSION') == pinned('dreamo', 'diffusers')
    models = json.loads((RUNTIMES / 'dreamo/src/picpatch_dreamo/models.json').read_text())
    assert f"flux1-dreamo-v{constant(adapter, 'DREAMO_VERSION')}" in [model['id'] for model in models]
