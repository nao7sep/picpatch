"""Map named subjects to distinct learned DreamO reference slots."""
import re
from picpatch_worker_core.errors import InvalidEditInput


def bind_references(request):
    groups = request.get('references', [])
    if any(request.get(key) is not None for key in ('sourceImage', 'maskImage', 'outpaint', 'control')):
        raise InvalidEditInput('DreamO accepts reference-only composition.')
    if not 1 <= len(groups) <= 2:
        raise InvalidEditInput('DreamO requires one or two independently indexed references.')
    prompt = request["instruction"]
    if re.search(r"\[ref#[0-9]+\]", prompt, re.IGNORECASE):
        raise InvalidEditInput("Reference tokens are reserved for the adapter.")
    bindings, names = [], set()
    for index, group in enumerate(groups, 1):
        name = group.get('id')
        images = group.get('images', [])
        if not isinstance(name, str) or not name or name in names or any(char in name for char in '{}') or group.get('role') not in ('subject', 'object') or len(images) != 1 or group.get('conditioning') != 'identity' or group.get("className") is not None or "{" + name + "}" not in request["instruction"]:
            raise InvalidEditInput('Each distinct subject or object requires exactly one photograph.')
        names.add(name)
        bindings.append({'index': index, 'path': images[0]})
        prompt = prompt.replace("{" + name + "}", f"[ref#{index}]")
    return bindings, prompt
