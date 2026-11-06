// Frontend process launcher only. The game authority is Python.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=process.env.WEDDING_PYTHON||path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
if(!existsSync(python)){
  console.error('Create .venv and install backend/requirements.txt first. See README.md.');process.exit(1);
}
const children=[];
let closing=false;
function stop(code=0){
  if(closing)return;closing=true;
  for(const child of children)child.kill('SIGTERM');
  process.exitCode=code;
}
for(const [command,args]of [
  [python,['-m','uvicorn','backend.app.main:app','--host','127.0.0.1','--port','8000','--workers','1','--ws-max-size','8192','--ws-max-queue','16','--no-access-log','--env-file','.env']],
  [process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1']],
]){
  const child=spawn(command,args,{cwd:root,stdio:'inherit',windowsHide:true});children.push(child);
  child.on('error',error=>{console.error(error.message);stop(1);});
  child.on('exit',code=>{if(!closing)stop(code||0);});
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
