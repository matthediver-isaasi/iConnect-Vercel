#!/usr/bin/env node
// Separate from held adoption. No provider mutation is called by this runner.
// --migration: offline review; add --apply --review-sha256=<SQL hash> to apply.
// --proof /tmp/reviewed-production.json --out /tmp/NEW.json: release dry-run.
// Add --apply --review-sha256=<release hash> to release to the dynamic worker.
// Proof JSON: version:1, projectId, teamId(optional), deploymentId, commit,
// sourceHashes:{ repository-relative required API source paths: SHA256, ... }.
// All hashes must match local files AND git blobs at the active READY production
// commit, verified live through Vercel API, anchored to the previously verified
// production deployment. Use VERCEL_API_TOKEN with read access, or use the
// owner-only run-bnms-dd-pilot-release-bridge.mjs shell runner and attach its
// sandbox connector service. The connector credential is never exposed.
// Released replay is zero-write provenance verification, NOT renewed readiness.
import { readFile,open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { parseAdoptionArgs,readAdoptionEvidence } from './run-bnms-dd-pilot-adoption.mjs';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { TENANT_ID,MEMBER_ID } from './bnms-dd-pilot.mjs';
import { ACCOUNTING } from './bnms-dd-pilot-adoption.mjs';
import { verifyDeploymentProof } from './bnms-dd-pilot-deployment-proof.mjs';
import { releasePilot } from './bnms-dd-pilot-release.mjs';
const MIGRATION=new URL('../supabase/migrations/20261111_bnms_dd_pilot_release.sql',import.meta.url);
export function parseReleaseArgs(args){
  const remaining=[];let proof;
  for(let n=0;n<args.length;n++){
    if(args[n]==='--proof'){
      if(proof||!args[n+1]||args[n+1].startsWith('--'))throw Error('One production proof file required');
      proof=args[++n];
    }else remaining.push(args[n]);
  }
  const o=parseAdoptionArgs(remaining);
  if(o.migration?!!proof:!proof)throw Error('Production proof is required only for release data mode');
  return {...o,proof};
}
export async function verifyReleaseAccounts(db,{transport=fetch}={}){
  const {data:tokens,error}=await db.from('xero_token').select('tenant_id,access_token,expires_at').eq('app_tenant_id',TENANT_ID);
  if(error||tokens?.length!==1||tokens[0].tenant_id!==ACCOUNTING.xero_tenant_id
    ||!Number.isFinite(Date.parse(tokens[0].expires_at))||Date.parse(tokens[0].expires_at)<Date.now()+60000)throw Error('Pinned unexpired Xero token required');
  const get=async suffix=>{
    const r=await transport(`https://api.xero.com/api.xro/2.0/${suffix}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${tokens[0].access_token}`,'Xero-tenant-id':tokens[0].tenant_id,Accept:'application/json'}});
    if(!r.ok)throw Error(`Xero account verification failed HTTP ${r.status}`);
    const accounts=(await r.json()).Accounts;
    if(accounts?.length!==1)throw Error('Xero account identity ambiguous');
    return accounts[0];
  };
  return {bank:await get(`Accounts/${ACCOUNTING.bank_account_id}`),
    revenue:await get('Accounts/8f87b705-a870-4c5e-b46a-74a5a4de73ce')};
}
export async function main(args=process.argv.slice(2),env=process.env,{vercelRequest}={}){
  const o=parseReleaseArgs(args),sql=await readFile(MIGRATION,'utf8'),hash=createHash('sha256').update(sql).digest('hex');
  if(o.migration&&!o.apply){console.log(JSON.stringify({mode:'migration_review',hash,writes:0}));return;}
  if(o.migration&&o.reviewSha256!==hash)throw Error('Release migration hash mismatch');
  destinationTarget(env);
  const client=await destinationConnection(env),report=o.out?await open(resolve(o.out),'wx',0o600):null;
  try{
    await client.connect();await client.query("SET statement_timeout='120s'");await client.query("SET lock_timeout='10s'");
    let result;
    if(o.migration){
      await client.query('BEGIN');try{await client.query(sql);await client.query('COMMIT');}
      catch(e){await client.query('ROLLBACK');throw e;}
      result={mode:'migration_applied',hash};
    }else{
      const exists=(await client.query("SELECT to_regclass('public.bnms_dd_pilot_release') IS NOT NULL AS ready")).rows[0].ready;
      const prior=exists?(await client.query('SELECT id FROM bnms_dd_pilot_release WHERE member_id=$1 AND tenant_id=$2',[MEMBER_ID,TENANT_ID])).rows:[];
      let evidence,proof,accounts;
      if(!prior.length){
        const raw=JSON.parse(await readFile(o.proof,'utf8'));
        proof=await verifyDeploymentProof(raw,{token:env.VERCEL_API_TOKEN,vercelRequest});
        if(!env.DEST_SUPABASE_KEY)throw Error('Pinned destination service credential required');
        const db=createClient(env.DEST_SUPABASE_URL,env.DEST_SUPABASE_KEY,{auth:{persistSession:false}});
        const {data:tenant,error}=await db.from('tenant').select('id,name').eq('id',TENANT_ID).single();
        if(error||!/\bbnms\b|british nuclear medicine society/i.test(tenant?.name||''))throw Error('Destination BNMS tenant mismatch');
        evidence=await readAdoptionEvidence(db);
        accounts=await verifyReleaseAccounts(db);
        // Reduce the deployment-change gap after provider/accounting reads.
        await verifyDeploymentProof(raw,{token:env.VERCEL_API_TOKEN,vercelRequest});
      }
      result=await releasePilot(client,{evidence,proof,accounts,apply:o.apply,
        reviewSha256:o.reviewSha256,verifiedDestination:true});
      await report.writeFile(JSON.stringify({...result,evidence,accounts},null,2));
    }
    console.log(JSON.stringify({mode:result.mode,hash:result.hash,writes:result.writes,providerWrites:0,
      paymentScheduled:result.paymentScheduled??null,settlementVerified:false}));
  }finally{await client.end();await report?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(`BNMS release failed: ${e.code||e.name}. Verify private proof and readiness; no provider scheduling is performed by this runner.`);process.exitCode=1;});