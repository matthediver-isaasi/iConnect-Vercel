import { chmod, link, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_RESPONSE_BYTES=2*1024*1024;
const PATH_PATTERN=/^\/(?:v13\/deployments\/dpl_[A-Za-z0-9]+|v9\/projects\/prj_[A-Za-z0-9]+)(?:\?teamId=[A-Za-z0-9_-]+)?$/;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function privateFile(path){
  const metadata=await stat(path);
  return metadata.uid===process.getuid()&&(metadata.mode&0o077)===0&&metadata.isFile();
}
export async function startVercelRequestBridge(directory,{ttlMs=300000,requestTimeoutMs=30000}={}){
  directory=resolve(directory);
  if(ttlMs<30000||requestTimeoutMs<1000)throw Error('Secure bridge options required');
  await mkdir(directory,{mode:0o700});
  await chmod(directory,0o700);
  await mkdir(join(directory,'requests'),{mode:0o700});
  await mkdir(join(directory,'responses'),{mode:0o700});
  const expiresAt=Date.now()+ttlMs;
  await writeFile(join(directory,'session.json'),JSON.stringify({version:1,expiresAt,pid:process.pid}),
    {flag:'wx',mode:0o600});
  let closed=false;
  return {
    async request(path,init={}){
      if(closed||Date.now()>=expiresAt)throw Error('Vercel connector bridge unavailable');
      if(init.method!=='GET'||!PATH_PATTERN.test(path))throw Error('Disallowed Vercel connector request');
      const id=randomBytes(24).toString('hex'),deadline=Math.min(expiresAt,Date.now()+requestTimeoutMs);
      const requestPath=join(directory,'requests',`${id}.json`);
      await writeFile(requestPath,JSON.stringify({version:1,id,path,method:'GET',deadline}),{flag:'wx',mode:0o600});
      const responsePath=join(directory,'responses',`${id}.json`);
      try{
        while(Date.now()<deadline){
          try{
            if(!await privateFile(responsePath))throw Error('Insecure Vercel connector response');
            const raw=await readFile(responsePath);
            if(raw.length>MAX_RESPONSE_BYTES)throw Error('Vercel connector response too large');
            const response=JSON.parse(raw);
            if(response?.version!==1||response.id!==id||!Number.isInteger(response.status)
              ||typeof response.body!=='string')throw Error('Invalid Vercel connector response');
            return {ok:response.status>=200&&response.status<300,status:response.status,
              json:async()=>JSON.parse(response.body)};
          }catch(error){
            if(error.code!=='ENOENT')throw error;
          }
          await pause(50);
        }
        throw Error('Vercel connector request timed out');
      }finally{
        await rm(requestPath,{force:true});await rm(responsePath,{force:true});
      }
    },
    async close(){
      if(closed)return;
      closed=true;
      await writeFile(join(directory,'done.json'),JSON.stringify({version:1,pid:process.pid}),
        {flag:'wx',mode:0o600});
    },
  };
}
export async function pollVercelRequestBridge(directory){
  directory=resolve(directory);
  const sessionPath=join(directory,'session.json');
  if(!await privateFile(sessionPath))throw Error('Invalid private bridge session');
  const session=JSON.parse(await readFile(sessionPath,'utf8'));
  if(session.version!==1||!Number.isFinite(session.expiresAt)||Date.now()>=session.expiresAt)
    throw Error('Expired private bridge session');
  const names=(await readdir(join(directory,'requests'))).filter(name=>/^[a-f0-9]{48}\.json$/.test(name)).sort();
  for(const name of names){
    const path=join(directory,'requests',name);
    if(!await privateFile(path))continue;
    const request=JSON.parse(await readFile(path,'utf8'));
    if(request.version===1&&request.id===name.slice(0,-5)&&request.method==='GET'
      &&PATH_PATTERN.test(request.path)&&Number.isFinite(request.deadline)&&Date.now()<request.deadline)
      return {state:'request',...request};
  }
  try{
    if(await privateFile(join(directory,'done.json')))return {state:'done'};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return {state:'waiting'};
}
export async function installVercelBridgeResponse(directory,tempPath){
  directory=resolve(directory);tempPath=resolve(tempPath);
  if(dirname(tempPath)!==directory||!/^\.incoming-[a-f0-9]{16}\.json$/.test(basename(tempPath)))
    throw Error('Invalid bridge response staging path');
  const raw=await readFile(tempPath);
  if(raw.length>MAX_RESPONSE_BYTES)throw Error('Vercel connector response too large');
  const response=JSON.parse(raw),id=response?.id;
  if(response?.version!==1||typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id)
    ||!Number.isInteger(response.status)||typeof response.body!=='string')
    throw Error('Invalid Vercel connector response');
  const requestPath=join(directory,'requests',`${id}.json`);
  if(!await privateFile(requestPath))throw Error('No live Vercel connector request');
  const request=JSON.parse(await readFile(requestPath,'utf8'));
  if(request.id!==id||Date.now()>=request.deadline)throw Error('Stale Vercel connector response');
  const staged=join(directory,'responses',`.${id}.${randomBytes(8).toString('hex')}.tmp`);
  const handle=await open(staged,'wx',0o600);
  try{await handle.writeFile(raw);}finally{await handle.close();}
  try{await link(staged,join(directory,'responses',`${id}.json`));}
  finally{await rm(staged,{force:true});}
  await rm(tempPath,{force:true});
}