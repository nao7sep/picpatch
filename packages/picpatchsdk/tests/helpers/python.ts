import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Match uv's project-relative environment selection for every real Python test.
const worker = fileURLToPath(new URL('../../runtimes/mflux/', import.meta.url));
const environment = resolve(worker, process.env.UV_PROJECT_ENVIRONMENT ?? '.venv');
export const testPython = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
