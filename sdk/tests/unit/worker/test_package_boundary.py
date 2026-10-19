"""Worker sources stay inside the SDK and use only explicit process inputs."""
import ast
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / 'runtimes/mflux/src/picpatch_worker'
RUNTIMES = ROOT / 'runtimes'
# Discover runtime packages from their source roots, not a hand-maintained family list.
PACKAGES = {package.name for source in RUNTIMES.glob('*/src') for package in source.iterdir() if package.is_dir() and (package / '__init__.py').exists()}

def dependencies(path):
    runtime = RUNTIMES / path.relative_to(RUNTIMES).parts[0]
    manifest = runtime / 'pyproject.toml'
    # Shared protocol uses only the packages declared by the worker runtimes.
    manifests = [manifest] if manifest.exists() else list(RUNTIMES.glob('*/pyproject.toml'))
    names = set()
    for item in manifests:
        project = tomllib.loads(item.read_text())['project']
        specs = project.get('dependencies', []) + project.get('optional-dependencies', {}).get('inference', [])
        names.update(re.split(r'[<>=!~\[]', value)[0].replace('-', '_') for value in specs)
    if 'pillow' in names:
        names.add('PIL')
    if 'opencv_python' in names:
        names.add('cv2')
    return names


def violations(source, path):
    tree = ast.parse(source)
    allowed = sys.stdlib_module_names | dependencies(path) | PACKAGES
    package_root = next((parent for parent in path.parents if parent.parent.name == 'src'), path.parent)
    aliases = {}
    failures = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                aliases[item.asname or item.name.split('.')[0]] = item.name
                if item.name.split('.')[0] not in allowed:
                    failures.append('dependency')
        if isinstance(node, ast.ImportFrom):
            if node.level:
                if node.level > len(path.relative_to(package_root).parts):
                    failures.append('package escape')
            elif (node.module or '').split('.')[0] not in allowed:
                failures.append('dependency')
            for item in node.names:
                aliases[item.asname or item.name] = f'{node.module}.{item.name}'

    def name(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return name(node.value) + '.' + node.attr
        return ''

    protocol_entry = path == RUNTIMES / 'common/src/picpatch_worker_core/entry.py' or path.name == 'engine_probe.py'
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    for node in ast.walk(tree):
        value = name(node)
        if value in {'os.getenv', 'os.getcwd', 'pathlib.Path.cwd', 'pathlib.Path.home', 'os.path.expanduser'}:
            failures.append('ambient state')
        if value == 'os.environ':
            # Worker-owned fixed offline flags are writes, never caller configuration reads.
            parent = parents.get(node)
            call = parents.get(parent)
            fixed_write = isinstance(parent, ast.Attribute) and parent.attr == 'update' and isinstance(call, ast.Call) and not call.args and all(isinstance(k.value, ast.Constant) and k.value.value == '1' and k.arg in {'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY'} for k in call.keywords)
            if not fixed_write:
                failures.append('ambient environment')
        if value in {'sys.stdin', 'sys.stdout', 'sys.stderr', 'print'} and not protocol_entry:
            failures.append('standard stream')
    return failures


def test_worker_resources_have_no_consumer_dependencies_or_ambient_reads():
    paths = [path for source in RUNTIMES.glob('*/src') for path in source.rglob('*.py')] + list(RUNTIMES.glob('*/engine_probe.py'))
    assert {str(path.relative_to(ROOT)): found for path in paths if (found := violations(path.read_text(), path))} == {}


def test_guard_detects_planted_imports_aliases_environment_and_streams():
    source = 'import os as operating; from os import getenv as env; import app_private; from ....app import thing; import sys as system; operating.environ["KEY"]; env("KEY"); operating.getcwd(); system.stdout.write("x"); print("x")'
    found = violations(source, WORKER / 'backends/example.py')
    assert {'dependency', 'package escape', 'ambient environment', 'ambient state', 'standard stream'} <= set(found)
