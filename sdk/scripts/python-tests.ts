// Runs the worker's Python tests through the locked uv project without writing bytecode or a
// pytest cache into the source tree. Extra arguments go to pytest.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const result = spawnSync('uv', ['run', '--project', 'runtimes/mflux', '--locked', 'pytest', '-p', 'no:cacheprovider', 'tests/unit/worker', ...process.argv.slice(2)], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
