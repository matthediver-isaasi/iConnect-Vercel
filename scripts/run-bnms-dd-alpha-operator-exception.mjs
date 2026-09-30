#!/usr/bin/env node
// Default read-only; never runs the normal Xero readiness orchestrator.
// Apply requires parent-reviewed dry-run SHA and always reacquires fresh GC GETs.
// Replay reads the saved immutable applied artifact and NEVER refreshes evidence.
import {readFile,open,mkdir,chmod} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';

export function parseExceptionArgs(args){
  const opts={apply:false};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--apply'&&!opts.apply)opts.apply=true;
    else if(['--out','--review-sha256','--replay'].includes(args[i])&&!opts[args[i].slice(2)]&&args[i+1]&&!args[i+1].startsWith('--'))
      opts[args[i].slice(2)]=args[++i];
    else throw Error('Unsupported/duplicate exception argument; identity overrides forbidden');
  }
  if(!opts.out||!resolve(opts.out).startsWith(`${resolve('exports')}/`)
    ||(opts.apply&&!/^[a-f0-9]{64}$/.test(opts['review-sha256']||''))
    ||(opts.replay&&opts.apply)||(!opts.apply&&!opts.replay&&opts['review-sha256']))
    throw Error('Private output and exact reviewed apply hash required; replay cannot apply');
  return opts;
}

export async function main(args=process.argv.slice(2)){
  const opts=parseExceptionArgs(args);
  destinationTarget(process.env);
  process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
  const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
  const {prepareExceptionEvidence,releaseOperatorException}=await import('./bnms-dd-alpha-operator-exception.mjs');
  await mkdir(dirname(resolve(opts.out)),{recursive:true,mode:0o700});
  await chmod(dirname(resolve(opts.out)),0o700);
  const output=await open(resolve(opts.out),'wx',0o600);
  const c=await destinationConnection();let connected=false,evidence;
  try{
    await c.connect();connected=true;
    if(opts.replay){
      const saved=JSON.parse(await readFile(opts.replay,'utf8'));
      if(saved.result?.mode!=='operator_exception_alpha_armed'||!saved.evidence)
        throw Error('Original applied exception evidence required for read-only replay');
      evidence=saved.evidence;
    }else{
      const {createClient}=await import('@supabase/supabase-js');
      const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,
        {auth:{persistSession:false,autoRefreshToken:false}});
      evidence=await prepareExceptionEvidence(c,db);
    }
    const result=await releaseOperatorException(c,evidence,{apply:opts.apply,reviewSha256:opts['review-sha256']});
    if(opts.replay&&result.mode!=='exception_release_replay')throw Error('Saved artifact is not an immutable journal replay');
    await output.writeFile(JSON.stringify({evidence,result},null,2));
    console.log(JSON.stringify({...result,out:resolve(opts.out),fullAlphaReadinessComplete:false,xeroRequests:0}));
  }catch(error){
    await output.writeFile(JSON.stringify({mode:'operator_exception_stopped',evidence:evidence||null,
      error:error.message,releaseAuthorized:false,fullAlphaReadinessComplete:false},null,2));
    throw error;
  }finally{if(connected)await c.end();await output.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(()=>{console.error('Alpha operator exception stopped; inspect restricted output. No authorization inferred.');process.exitCode=1;});