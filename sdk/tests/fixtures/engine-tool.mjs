import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'sync') {
  const project = args[args.indexOf('--project') + 1];
  const parent = join(project, '..');
  await writeFile(join(parent, 'observed.json'), JSON.stringify({ args, env: process.env }));
  await mkdir(join(process.env.UV_PROJECT_ENVIRONMENT, 'bin'), { recursive: true });
  await writeFile(join(process.env.UV_PROJECT_ENVIRONMENT, 'bin', 'python'), `#!${process.execPath}
if (process.argv.includes('--protocol-dir')) {
  const {createInterface} = require('node:readline');
  createInterface({input:process.stdin}).on('line', line => {
    const request=JSON.parse(line);
    const response=request.type==='hello' ? {type:'ready',workerVersion:'fixture',models:[]} : {type:'shutdownAck'};
    console.log(JSON.stringify({version:1,id:request.id,...response}));
    if(request.type==='shutdown')process.exit(0);
  });
} else console.log(JSON.stringify({ready:true}));
`, { mode: 0o755 });
} else if (args[0] !== 'pip') {
  throw new Error('Unexpected engine command');
}
