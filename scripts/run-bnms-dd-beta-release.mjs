#!/usr/bin/env node
// Default: private read-only readiness report. No provider writes.
// --schema: offline hash review; --apply --review-sha256=... applies schema only.
// --out /tmp/new.json [--proof /tmp/verified-input.json]: fresh readiness/dry run.
// Data apply also requires --proof and the exact dry-run manifest hash.
// --attestation FILE explicitly uses a structured user-supplied local Vercel
// report, requires --proof, and preserves its original timestamp and raw digest.
// It expires after 15 minutes, including lock waits and commit time. It is never
// an automatic fallback for failed machine verification or a claimed commit.
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
export function parseBetaReleaseArgs(args){
  const o={schema:false,apply:false};
  for(let n=0;n<args.length;n++){
    const a=args[n];
    if(['--schema','--apply'].includes(a)&&!o[a.slice(2)])o[a.slice(2)]=true;
    else if(['--out','--proof','--replay','--handover','--attestation','--xero-evidence','--xero-exception'].includes(a)&&!o[a.slice(2)]&&args[n+1]&&!args[n+1].startsWith('--'))o[a.slice(2)]=args[++n];
    else if(/^--review-sha256=[a-f0-9]{64}$/.test(a)&&!o.reviewSha256)o.reviewSha256=a.split('=')[1];
    else throw Error('Unsupported beta release argument; identity overrides and provider writes forbidden');
  }
  if(o.schema?(o.out||o.proof||o.replay||o.handover||o.attestation):(!o.out||!resolve(o.out).startsWith('/tmp/')))throw Error('Separate schema mode or new private /tmp report required');
  if(o.attestation&&!o.proof)throw Error('Explicit attestation requires --proof');
  if(!!o['xero-evidence']!==!!o['xero-exception']||((o.schema||o.replay)&&o['xero-evidence']))
    throw Error('Prior Xero evidence and explicit exception must be paired, separate from schema/replay');
  if(o.apply&&!o.reviewSha256)throw Error('Exact reviewed hash required');
  if(o.apply&&!o.schema&&!o.proof)throw Error('Active deployment proof required for release');
  if(o.replay&&(o.apply||!o.reviewSha256||o.proof||o.handover||o.attestation))throw Error('Replay is read-only and requires only original report/hash and new output');
  return o;
}
export function safeBetaReleaseError(error){
  if(Array.isArray(error?.betaSchemaMismatches)&&error.betaSchemaMismatches.every(message=>
    /^(Installed beta guard function\/security differs: [a-z_]+|Beta [A-Za-z0-9_ ():;/,.-]+|Unexpected beta journal constraint)$/.test(message)))
    return {reason:error.betaSchemaMismatches.join('; '),schemaMismatches:error.betaSchemaMismatches};
  if(/^[0-9A-Z]{5}$/.test(error?.code||''))return {reason:'Database validation failed',sqlState:error.code};
  const message=error?.message||'';
  if(/^(User-supplied Vercel attestation is future-dated or exceeds 15 minutes|Pinned unexpired Xero authentication required|(?:GC|Xero) read HTTP \d+|Oldest readiness evidence must be within 15 minutes, including reads and transaction time|Legacy handover must be reattested within 24 hours of arming|Beta release blocked: unresolved readiness\/deployment evidence)$/.test(message))
    return {reason:message};
  return {reason:'Beta readiness/release validation failed; inspect local validation stage',errorType:error?.name||'Error'};
}
export async function main(args=process.argv.slice(2),env=process.env,{vercelRequest}={}){
  const o=parseBetaReleaseArgs(args);
  // Bootstrap before importing anything that captures the default DB.
  destinationTarget(env);
  process.env.SUPABASE_URL=env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY=env.DEST_SUPABASE_KEY;
  const {createClient}=await import('@supabase/supabase-js');
  const {destinationConnection}=await import('./run-bnms-dd-pilot-history.mjs');
  const {verifyDeploymentProof,verifyUserDeploymentAttestation}=await import('./bnms-dd-pilot-deployment-proof.mjs');
  const {MIGRATION,readBetaReleaseEvidence,releaseBeta,verifyBetaReleaseSchema}=await import('./bnms-dd-beta-release.mjs');
  const sql=await readFile(MIGRATION,'utf8'),sqlHash=createHash('sha256').update(sql).digest('hex');
  if(o.schema){
    if(!o.apply)return console.log(JSON.stringify({mode:'schema_review',hash:sqlHash,writes:0}));
    if(o.reviewSha256!==sqlHash)throw Error('Reviewed schema hash mismatch');
    const c=await destinationConnection(env);await c.connect();
    try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s';SET LOCAL statement_timeout='120s'");
      await c.query(sql);await verifyBetaReleaseSchema(c);await c.query('COMMIT');
      console.log(JSON.stringify({mode:'schema_applied_no_members_released',hash:sqlHash}));
    }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
    return;
  }
  const file=await open(resolve(o.out),'wx',0o600);
  let report,proof,result,stage='deployment_verification';
  const persist=async payload=>{await file.truncate(0);await file.write(JSON.stringify(payload,null,2),0,'utf8');};
  try{
    const db=createClient(env.DEST_SUPABASE_URL,env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    if(o.replay){
      const saved=JSON.parse(await readFile(resolve(o.replay),'utf8'));
      if(!saved.report||!saved.proof||saved.result?.hash!==o.reviewSha256)throw Error('Original reviewed report required for replay');
      report=saved.report;proof=saved.proof;
    }else{
      // Fail closed before spending the readiness provider budget; no fallback.
      if(o.proof){
        const reviewedProof=JSON.parse(await readFile(resolve(o.proof),'utf8'));
        proof=o.attestation
          ?await verifyUserDeploymentAttestation(reviewedProof,await readFile(resolve(o.attestation),'utf8'))
          :await verifyDeploymentProof(reviewedProof,{vercelRequest});
      }
      stage='provider_readiness';
      const xeroException=o['xero-evidence']?{
        raw:await readFile(resolve(o['xero-evidence']),'utf8'),
        approval:JSON.parse(await readFile(resolve(o['xero-exception']),'utf8'))}:null;
      report=await readBetaReleaseEvidence(db,{handover:o.handover?JSON.parse(await readFile(resolve(o.handover),'utf8')):null,xeroException});
    }
    // Preserve completed GET evidence even if the subsequent SQL/schema phase
    // fails. This is diagnostic evidence, never renewed release authorization.
    await persist({report,proof,result:{mode:'readiness_collected_pending_validation',writes:0,providerWrites:0}});
    const blockers=[...report.globalBlockers,...report.members.flatMap(m=>m.blockers.map(b=>`${m.memberId}: ${b}`))];
    if(!proof)blockers.push('Matching updated pilot/beta worker must be proven active in production');
    if(blockers.length){
      result={mode:'blocked_beta_readiness',writes:0,blockers};
      if(o.apply)throw Error('Release blocked: unresolved readiness/deployment evidence');
    }else{
      stage='sql_release_validation';
      const c=await destinationConnection(env);await c.connect();
      try{result=await releaseBeta(c,report,proof,{apply:o.apply,reviewSha256:o.reviewSha256,verifiedDestination:true});}
      finally{await c.end();}
      if(o.replay&&(result.mode!=='release_replay'||result.hash!==o.reviewSha256))throw Error('Replay does not match immutable journal');
    }
    await persist({report,proof,result});
    console.log(JSON.stringify({mode:result.mode,hash:result.hash,writes:result.writes,providerWrites:0,blockers,
      members:report.members.length,historicalInvoices:report.members.reduce((n,m)=>n+m.historicalInvoiceCount,0),
      subscriptions:report.members.reduce((n,m)=>n+m.provider.subscriptions.length,0),
      pendingPayments:report.members.reduce((n,m)=>n+m.provider.payments.filter(p=>['pending_submission','submitted','confirmed'].includes(p.status)).length,0),
      futureOrOutstandingInvoices:report.members.reduce((n,m)=>n+m.futureInvoices.length,0),out:resolve(o.out)}));
  }catch(error){
    await persist({report,proof,result:{mode:'beta_readiness_stopped',stage,...safeBetaReleaseError(error),
      writesConfirmed:result?.writes??0,providerWrites:0,applyRequested:o.apply}});
    throw error;
  }finally{await file.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(e=>{console.error(`Beta release stopped: ${e.message}`);process.exitCode=1;});
}