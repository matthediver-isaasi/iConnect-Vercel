#!/usr/bin/env node
// Shell-side release runner for use with the durable-sandbox polling bridge.
// Start as a background shell task, then service its requests with the durable
// sandbox callbacks and the Vercel connector. Do not await a foreground runner
// before starting the coordinator: requests expire while it waits.
// The normal workspace environment is retained; no Vercel credential is exposed.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as releaseMain } from './run-bnms-dd-pilot-release.mjs';
import { startVercelRequestBridge } from './bnms-dd-vercel-connector-bridge.mjs';

export function parseBridgeArgs(args){
  const remaining=[];let directory;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--bridge-directory'){
      if(directory||!args[index+1]||args[index+1].startsWith('--'))throw Error('One bridge directory required');
      directory=resolve(args[++index]);
    }else remaining.push(args[index]);
  }
  if(!directory)throw Error('Bridge directory required');
  return {directory,remaining};
}
export async function main(args=process.argv.slice(2),env=process.env){
  const {directory,remaining}=parseBridgeArgs(args);
  const bridge=await startVercelRequestBridge(directory);
  try{return await releaseMain(remaining,env,{vercelRequest:bridge.request});}
  finally{await bridge.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{
    console.error(`BNMS bridged release failed: ${error.code||error.name}. No Vercel credential was exposed.`);
    process.exitCode=1;
  });