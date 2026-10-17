"""Ordered source and grouped-reference prompts shared by image editors."""
import json
from .errors import InvalidEditInput


def conditioning(request: dict) -> tuple[list[str], str]:
    """Flatten source then groups, explicitly associating every ordinal with its role."""
    paths = []
    descriptions = []
    if request.get('sourceImage'):
        paths.append(request['sourceImage'])
        descriptions.append('Image 1 is the source image to edit.')
    for group in request.get('references', []):
        numbers = []
        for image in group['images']:
            paths.append(image)
            numbers.append(str(len(paths)))
        descriptions.append(f"Images {', '.join(numbers)} are {group['role']} references for group {json.dumps(group['id'])}.")
    if not paths or (request.get('maskImage') and not request.get('sourceImage')):
        raise InvalidEditInput('Editing requires images; masked editing requires a source.')
    return paths, '\n'.join(descriptions) + '\n\n' + request['instruction']
