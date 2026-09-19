#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { TENANT_ID,digest,providerReader,readAllProviderPages } from './bnms-dd-pilot.mjs';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
import { fingerprint } from './bnms-dd-pilot-history.mjs';
import { SOURCE_HASH,START,betaManifest,adoptBeta } from './bnms-dd-beta-adoption.mjs';
const MIGRATION=new URL('../supabase/migrations/20261112_bnms_dd_beta_held.sql',import.meta.url);
export async function betaSchemaCatalogHash(c){
  const result=await c.query(`SELECT kind,name,definition FROM (
    SELECT 'column' AS kind,c.relname||'.'||a.attname AS name,
      jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'null',a.attnotnull,
        'default',pg_get_expr(d.adbin,d.adrelid))::text AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relname LIKE 'bnms_dd_beta_%' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'table',c.relname,jsonb_build_object('rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl)::text
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'bnms_dd_beta_%' AND c.relkind='r'
    UNION ALL SELECT 'constraint',c.relname||'.'||k.conname,pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'bnms_dd_beta_%'
    UNION ALL SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'bnms_dd_beta_%'
    UNION ALL SELECT 'function',p.proname,pg_get_functiondef(p.oid) FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'bnms_dd_beta_%' OR p.proname='bnms_dd_reject_history_mutation')
    UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,t.tgenabled::text||':'||pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
      AND c.relnamespace='public'::regnamespace AND (t.tgname LIKE 'bnms_dd_beta_%' OR c.relname LIKE 'bnms_dd_beta_%')
    UNION ALL SELECT 'policy',tablename||'.'||policyname,row_to_json(p)::text FROM pg_policies p
      WHERE schemaname='public' AND tablename LIKE 'bnms_dd_beta_%'
  ) evidence WHERE name NOT LIKE 'bnms_dd_beta_invoice%' ORDER BY kind,name`);
  return fingerprint(result.rows);
}
export async function applyBetaSchema(c,sql,reviewSha256){
  const hash=digest(sql);
  if(reviewSha256!==hash)throw Error('Reviewed schema hash differs');
  await c.query('BEGIN');
  try{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-beta-held'))");
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_beta_schema_revision') IS NOT NULL AS ready")).rows[0].ready;
    if(ready){
      await verifyBetaSchema(c,hash);
      await c.query('ROLLBACK');return {mode:'schema_replay',hash,writes:0};
    }
    await c.query(sql);
    await c.query('INSERT INTO bnms_dd_beta_schema_revision(sql_sha256,catalog_sha256) VALUES($1,$2)',[hash,await betaSchemaCatalogHash(c)]);
    await c.query('COMMIT');return {mode:'schema_applied',hash};
  }catch(e){await c.query('ROLLBACK');throw e;}
}
export async function verifyBetaSchema(c,hash){
  const saved=(await c.query('SELECT * FROM bnms_dd_beta_schema_revision')).rows;
  if(saved.length!==1||saved[0].sql_sha256!==hash||saved[0].catalog_sha256!==await betaSchemaCatalogHash(c))throw Error('Beta schema replay hash/catalog mismatch');
}
export function parseArgs(args) {
  const o={apply:false,schema:false};
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(['--apply','--schema'].includes(a)&&!o[a.slice(2)])o[a.slice(2)]=true;
    else if(['--evidence','--out'].includes(a)&&!o[a.slice(2)]&&args[i+1]&&!args[i+1].startsWith('--'))o[a.slice(2)]=args[++i];
    else if(/^--review-sha256=[a-f0-9]{64}$/.test(a)&&!o.reviewSha256)o.reviewSha256=a.split('=')[1];
    else throw Error('Unsupported or duplicate beta flag; identities and release cannot be overridden');
  }
  if(o.apply&&!o.reviewSha256)throw Error('Exact reviewed hash required');
  if(o.schema?(o.evidence||o.out):(!o.evidence||!o.out||!resolve(o.out).startsWith('/tmp/')))throw Error('Separate schema mode or evidence + private /tmp out required');
  return o;
}
export async function verifyProvider(manifest,credentials,transport=fetch) {
  const get=providerReader(credentials,transport),proof=[];
  // Extend read-only GET evidence to enumerate ALL mandates belonging to each
  // pinned customer; discovery being partial must not hide a second schedule.
  const list=async(resource,query)=>{
    if(resource!=='mandates')throw Error('Unexpected beta provider resource');
    const u=new URL('https://api.gocardless.com/mandates');
    for(const[k,v]of Object.entries(query))u.searchParams.set(k,v);
    const r=await transport(u,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${credentials.accessToken}`,'GoCardless-Version':'2015-07-06'}});
    if(!r.ok)throw Error(`Live mandate enumeration failed (HTTP ${r.status})`);
    return r.json();
  };
  for(const m of manifest.members){
    const i=m.identity;
    const mandate=(await get(`mandates/${i.mandateId}`)).mandates;
    const customer=(await get(`customers/${i.customerId}`)).customers;
    const mandates=await readAllProviderPages(list,'mandates',{customer:i.customerId});
    if(mandate?.status!=='active'||mandate.id!==i.mandateId||mandate.links?.customer!==i.customerId
      ||mandate.links?.creditor!=='CR0000B50W1Y2R'||customer?.id!==i.customerId
      ||mandates.length!==1||mandates[0].id!==i.mandateId
      ||mandates[0].links?.customer!==i.customerId
      ||(i.group==='direct_match'&&String(customer.email).trim().toLowerCase()!==i.email))throw Error('Provider ownership/mandate cardinality conflict');
    const payments=await readAllProviderPages(get,'payments',{mandate:i.mandateId});
    const subscriptions=await readAllProviderPages(get,'subscriptions',{mandate:i.mandateId});
    const expected=m.history.map(h=>h.evidence).sort((a,b)=>a.id.localeCompare(b.id));
    if(subscriptions.length||fingerprint(payments.sort((a,b)=>a.id.localeCompare(b.id)))!==fingerprint(expected))throw Error('Fresh provider history or schedule drift');
    proof.push({memberId:i.memberId,mandateCount:mandates.length,subscriptions:0,payments:payments.length,status:'active'});
  }
  return proof;
}
export async function main(args=process.argv.slice(2)){
  const o=parseArgs(args);
  if(o.schema){
    const sql=await readFile(MIGRATION,'utf8'),hash=digest(sql);
    if(!o.apply){console.log(JSON.stringify({mode:'schema_review',hash,bytes:Buffer.byteLength(sql),writes:0}));return;}
    if(o.reviewSha256!==hash)throw Error('Reviewed schema hash differs');
    const c=await destinationConnection();await c.connect();
    let result;
    try{result=await applyBetaSchema(c,sql,o.reviewSha256);}finally{await c.end();}
    console.log(JSON.stringify(result));return;
  }
  destinationTarget(process.env);
  const bytes=await readFile(o.evidence);
  if(digest(bytes)!==SOURCE_HASH)throw Error('Pinned ten-candidate evidence fingerprint mismatch');
  const manifest=betaManifest(JSON.parse(bytes)),hash=fingerprint(manifest);
  if(o.apply&&o.reviewSha256!==hash)throw Error('Reviewed data hash differs');
  // Reserve the audit output before any possible commit; an existing/unwritable
  // path must never make an applied batch appear to have failed before writing.
  const file=await open(resolve(o.out),'wx',0o600);
  try {
  // No refresh or Xero call: historical rows are provider-only evidence.
  const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const providerProof=await verifyProvider(manifest,await getTenantGocardlessCredentials(TENANT_ID,{db}));
  const c=await destinationConnection();await c.connect();
  let result;
  try{
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_beta_batch') IS NOT NULL AS ready")).rows[0].ready;
    if(ready)await verifyBetaSchema(c,digest(await readFile(MIGRATION,'utf8')));
    result=await adoptBeta(c,manifest,{apply:o.apply,reviewSha256:o.reviewSha256,verifiedDestination:true});
  }
  finally{await c.end();}
  // This legacy pinned beta stage is NOT an alpha importer or a complete import.
  // Future alpha completion must use assertHistoricalInvoicesComplete from
  // bnms-dd-beta-invoices.mjs against the full historical-payment set.
  await file.writeFile(JSON.stringify({...result,providerProof,firstManagedDate:START,accountingReconciled:false,
    importComplete:false,completionStatus:'provider_only_incomplete',historicalInvoicesRequired:true,collectionHeld:true},null,2));
  console.log(JSON.stringify({mode:result.mode,hash:result.hash,writes:result.writes,plannedRows:result.plannedRows,
    historicalRows:result.historicalRows,mirrorRows:result.mirrorRows,migrationRequired:result.migrationRequired,
    importComplete:false,completionStatus:'provider_only_incomplete',historicalInvoicesRequired:true,providerWrites:0,out:resolve(o.out)}));
  } finally { await file.close(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{
  console.error(`Beta adoption stopped: ${String(e.message).replace(/https?:\/\/\S+/g,'[redacted-url]')}`);process.exitCode=1;
});