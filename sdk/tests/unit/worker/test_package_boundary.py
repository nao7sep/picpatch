"""Worker sources stay inside the SDK and use only explicit process inputs."""
import ast
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / 'runtimes/mflux/src/picpatch_worker'
PROJECT = tomllib.loads((ROOT / 'runtimes/mflux/pyproject.toml').read_text())['project']
DEPENDENCIES = {re.split(r'[<>=!~\[]', item)[0].replace('-', '_') for item in PROJECT['dependencies'] + PROJECT['optional-dependencies']['inference']}
DEPENDENCIES.add('PIL')  # Pillow's import name differs from its distribution name.


def violations(source, path):
    tree = ast.parse(source)
    aliases = {}
    failures = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                aliases[item.asname or item.name.split('.')[0]] = item.name
                if item.name.split('.')[0] not in sys.stdlib_module_names | DEPENDENCIES | {'picpatch_worker'}:
                    failures.append('dependency')
        if isinstance(node, ast.ImportFrom):
            if node.level:
                if node.level > len(path.relative_to(WORKER).parts):
                    failures.append('package escape')
            elif (node.module or '').split('.')[0] not in sys.stdlib_module_names | DEPENDENCIES | {'picpatch_worker'}:
                failures.append('dependency')
            for item in node.names:
                aliases[item.asname or item.name] = f'{node.module}.{item.name}'

    def name(node):
        if isinstance(node, ast.Name):
            return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return name(node.value) + '.' + node.attr
        return ''

    protocol_entry = path == WORKER / '__main__.py' or path == ROOT / 'runtimes/mflux/engine_probe.py'
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
    paths = list(WORKER.rglob('*.py')) + [ROOT / 'runtimes/mflux/engine_probe.py']
    assert {str(path.relative_to(ROOT)): found for path in paths if (found := violations(path.read_text(), path))} == {}


def test_guard_detects_planted_imports_aliases_environment_and_streams():
    source = 'import os as operating; from os import getenv as env; import app_private; from ....app import thing; import sys as system; operating.environ["KEY"]; env("KEY"); operating.getcwd(); system.stdout.write("x"); print("x")'
    found = violations(source, WORKER / 'backends/example.py')
    assert {'dependency', 'package escape', 'ambient environment', 'ambient state', 'standard stream'} <= set(found)
