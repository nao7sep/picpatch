import { installEngine } from 'picpatchsdk';
import { resolve } from 'node:path';

const uv = process.argv[2];
const root = process.argv[3];
const toolDirectories = process.argv.slice(4).map(path => resolve(path));
if (!uv) throw new Error('Pass the path to uv, and optionally an engine directory followed by CMake/compiler tool directories.');
const engine = await installEngine({ uvExecutable: resolve(uv), toolDirectories, ...(root ? { engineDirectory: resolve(root) } : {}) },
  { onEvent: event => console.log(event.stage, event.message) });
console.log(engine.engineDirectory);
