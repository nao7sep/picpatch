// Runs the worker's Python tests through the locked uv project. The environment, coverage data and
// bytecode stay out of the source tree: the environment lives in the platform cache, bytecode is not
// written and pytest keeps no cache. Extra arguments go to pytest.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheFolder } from '../tests/helpers/live-cache.ts';

const env = { ...process.env, UV_PROJECT_ENVIRONMENT: cacheFolder('picpatch-dev', 'python-tests'), COVERAGE_FILE: cacheFolder('picpatch-dev', 'python-coverage'), PYTHONDONTWRITEBYTECODE: '1' };
const result = spawnSync('uv', ['run', '--project', 'runtimes/mflux', '--locked', 'pytest', '-p', 'no:cacheprovider', 'tests/unit/worker', ...process.argv.slice(2)], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
