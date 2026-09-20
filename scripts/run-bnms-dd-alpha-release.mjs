#!/usr/bin/env node
// Default is read-only. Schema and arming each require their own reviewed hash.
// There is no provider-write, email, invoice, cron or deployment operation here.
import {readFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';

export function parseAlphaReleaseArgs(args){
  const opts={apply:false,schema:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i],key=arg.slice(2);
    if(['--apply','--schema'].includes(arg)&&!opts[key])opts[key]=true;
    else if(/^--review-sha256=[a-f0-9]{64}$/.test(arg)&&!opts.reviewSha256)opts.reviewSha256=arg.split('=')[1];
    else if(['manifest','out','handover','proof','replay'].includes(key)&&arg===`--${key}`&&!opts[key]
      &&args[i+1]&&!args[i+1].startsWith('--'))opts[key]=args[++i];
    else throw Error('Unsupported/duplicate alpha release argument; identity overrides forbidden');
  }
  if(opts.schema){
    if(opts.manifest||opts.out||opts.handover||opts.proof||opts.replay)throw Error('Schema and member-release modes must be separate');
  }else if(!opts.out||!resolve(opts.out).startsWith(`${resolve('exports')}/`)
    ||(!opts.replay&&(!opts.manifest||!opts.handover||!opts.proof)))
    throw Error('Pinned manifest, exact-alpha handover, deployment proof and private exports output required');
  if(opts.apply&&!opts.reviewSha256)throw Error('Exact reviewed SHA-256 required');
  if(opts.replay&&(opts.apply||!opts.reviewSha256||opts.manifest||opts.handover||opts.proof))
    throw Error('Replay is read-only and requires only original report/hash and new output');
  return opts;
}

export async function main(args=process.argv.slice(2),env=process.env,{vercelRequest}={}){
  const opts=parseAlphaReleaseArgs(args);
  // Validate destination and set default DB before importing runtime helpers.
  destinationTarget(env);
  process.env.SUPABASE_URL=env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY=env.DEST_SUPABASE_KEY;
  const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
  const {verifyDeploymentProof}=await import('./bnms-dd-pilot-deployment-proof.mjs');
  const {alphaSchemaBundle,readAlphaReleaseEvidence,releaseAlpha,verifyAlphaReleaseSchema}=await import('./bnms-dd-alpha-release.mjs');
  const bundle=await alphaSchemaBundle(),schemaHash=bundle.hash;
  if(opts.schema){
    if(!opts.apply){console.log(JSON.stringify({mode:'alpha_schema_review',hash:schemaHash,migrations:bundle.migrations,writes:0}));return;}
    if(opts.reviewSha256!==schemaHash)throw Error('Reviewed alpha schema hash mismatch');
    const c=await destinationConnection(env);await c.connect();
    try{
      await c.query('BEGIN');
      await c.query("SET LOCAL timezone='UTC'; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
      await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-alpha-scheduled-release'))");
      await c.query('LOCK TABLE public.membership_payment_plans,public.gocardless_collection_reservations IN SHARE ROW EXCLUSIVE MODE');
      const exists=(await c.query(`SELECT to_regclass('public.bnms_dd_alpha_release') IS NOT NULL AS release,
        to_regclass('public.bnms_alpha_invoice_operations') IS NOT NULL AS invoice`)).rows[0];
      if(!exists.release)await c.query(bundle.releaseSql);
      if(!exists.invoice)await c.query(bundle.invoiceSql);
      await verifyAlphaReleaseSchema(c);
      await c.query('COMMIT');
      console.log(JSON.stringify({mode:exists.release&&exists.invoice?'alpha_schema_replay':'alpha_schema_applied_no_members_released',
        hash:schemaHash,migrations:bundle.migrations}));
    }catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}
    return;
  }
  const output=await open(resolve(opts.out),'wx',0o600);
  try{
    let report,proof,result;
    if(opts.replay){
      const saved=JSON.parse(await readFile(resolve(opts.replay),'utf8'));
      if(!saved.report||!saved.proof||saved.result?.hash!==opts.reviewSha256)
        throw Error('Original alpha readiness/release report and hash required');
      report=saved.report;proof=saved.proof;
    }else{
      // Reject missing/stale deployment before spending the bounded API budget.
      proof=await verifyDeploymentProof(JSON.parse(await readFile(resolve(opts.proof),'utf8')),{vercelRequest});
      const {createClient}=await import('@supabase/supabase-js');
      const db=createClient(env.DEST_SUPABASE_URL,env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
      report=await readAlphaReleaseEvidence(db,{
        manifest:JSON.parse(await readFile(resolve(opts.manifest),'utf8')),
        handover:JSON.parse(await readFile(resolve(opts.handover),'utf8'))});
    }
    const blockers=[...report.globalBlockers,...report.members.flatMap(m=>m.blockers.map(b=>`${m.memberId}: ${b}`))];
    if(blockers.length){
      result={mode:'blocked_alpha_readiness',writes:0,blockers};
      await output.writeFile(JSON.stringify({report,proof,result},null,2));
      if(opts.apply)throw Error('Alpha release blocked by unresolved readiness evidence');
    }else{
      const c=await destinationConnection(env);await c.connect();
      try{
        await c.query("SET timezone='UTC'");
        result=await releaseAlpha(c,report,proof,{apply:opts.apply,reviewSha256:opts.reviewSha256,verifiedDestination:true});
      }finally{await c.end();}
      if(opts.replay&&(result.mode!=='release_replay'||result.hash!==opts.reviewSha256))
        throw Error('Read-only alpha replay does not match immutable journal');
      await output.writeFile(JSON.stringify({report,proof,result},null,2));
    }
    console.log(JSON.stringify({mode:result.mode,hash:result.hash,members:report.members.length,
      historicalInvoiceCount:report.members.reduce((n,m)=>n+m.historicalInvoiceCount,0),
      writes:result.writes,providerWrites:0,blockers,out:resolve(opts.out)}));
  }finally{await output.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(`Alpha release stopped: ${error.message}`);process.exitCode=1;});