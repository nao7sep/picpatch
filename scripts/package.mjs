import { packager } from '@electron/packager';
import { transform } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = join(root, 'dist', 'package');
await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
await mkdir(join(staging,'dist'),{recursive:true});
for (const file of ['main.mjs','preload.cjs','backup-worker.mjs','records-worker.mjs','renderer.js','index.html','style.css']) await cp(join(root,'dist',file),join(staging,'dist',file));
const sdk = JSON.parse(await readFile(join(root,'sdk','package.json'),'utf8'));
// The app's distribution compiles its bundled source dependency; the standalone SDK remains source-only.
async function compile(directory, target) {
  await mkdir(target,{ recursive:true });
  for (const entry of await readdir(directory,{ withFileTypes:true })) {
    const source=join(directory,entry.name), destination=join(target,entry.name);
    if(entry.isDirectory()) await compile(source,destination);
    else if(entry.name.endsWith('.ts')) { const result=await transform(await readFile(source,'utf8'),{loader:'ts',format:'esm',target:'node24'}); await writeFile(destination.replace(/\.ts$/,'.js'),result.code.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts\1/g,'$1$2.js$1')); }
    else await cp(source,destination);
  }
}
await compile(join(root,'sdk','src'),join(staging,'sdk','src'));
for (const name of ['protocol','LICENSE','THIRD_PARTY_NOTICES']) await cp(join(root,'sdk',name),join(staging,'sdk',name),{recursive:true});
await mkdir(join(staging,'sdk','runtimes','mflux'),{recursive:true});
for (const name of ['pyproject.toml','uv.lock','engine_probe.py','src']) await cp(join(root,'sdk','runtimes','mflux',name),join(staging,'sdk','runtimes','mflux',name),{recursive:true,filter:source=>!source.includes('__pycache__')&&!source.endsWith('.pyc')});
await writeFile(join(staging,'sdk','package.json'),JSON.stringify({name:sdk.name,version:sdk.version,private:true,type:'module',main:'./src/index.js',exports:{'.':'./src/index.js','./types':'./src/browser-types.js'},dependencies:sdk.dependencies}));
const app=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
await writeFile(join(staging,'package.json'),JSON.stringify({name:app.name,productName:app.productName,version:app.version,private:true,type:'module',main:'dist/main.mjs',dependencies:{picpatchsdk:'file:./sdk'}}));
await execute('npm',['install','--offline','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:staging,maxBuffer:1024*1024});
const version=JSON.parse(await readFile(join(root,'node_modules','electron','package.json'),'utf8')).version;
const zipDirectory=join(root,'node_modules','.cache','picpatch-desktop');await mkdir(zipDirectory,{recursive:true});
const zip=join(zipDirectory,`electron-v${version}-darwin-arm64.zip`);
// Reuse the already authorized development runtime rather than downloading another Electron archive.
await execute('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',join(root,'node_modules','electron','dist','Electron.app'),zip]);
const paths=await packager({dir:staging,out:join(root,'dist'),name:'PicPatch',platform:'darwin',arch:'arm64',electronVersion:version,electronZipDir:zipDirectory,overwrite:true,asar:false,prune:true});
console.log(paths[0]);
