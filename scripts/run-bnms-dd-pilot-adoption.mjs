#!/usr/bin/env node
// Review schema: node scripts/run-bnms-dd-pilot-adoption.mjs --migration
// Apply reviewed schema: add --apply --review-sha256=<migration hash>
// Read-only dry run: --out /tmp/NEW-private-report.json
// Held adoption: same, plus --apply --review-sha256=<reviewed data hash>
// NO release flag: accounting, deployed worker readiness and fresh provider
// notice/duplicate checks must be separately reviewed before clearing HOLD.
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { TENANT_ID, MEMBER_ID, MANDATE_ID, CUSTOMER_ID, providerReader, readAllProviderPages } from './bnms-dd-pilot.mjs';
import { STRUCTURE_ID } from './bnms-dd-pilot-history.mjs';
import { adoptPilot, adoptionManifest, buildPilotSnapshot, CUTOVER } from './bnms-dd-pilot-adoption.mjs';
import { resolveDynamicCollectionPrice } from '../api/_lib/gocardlessDynamicCollections.js';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
const MIGRATION = new URL('../supabase/migrations/20261110_bnms_dd_pilot_adoption.sql',import.meta.url);
export function parseAdoptionArgs(args) {
  const o={apply:false,migration:false};
  for(let n=0;n<args.length;n++){
    const a=args[n];
    if(['--apply','--migration'].includes(a)&&!o[a.slice(2)])o[a.slice(2)]=true;
    else if(a==='--out'&&!o.out&&args[n+1]&&!args[n+1].startsWith('--'))o.out=args[++n];
    else if(/^--review-sha256=[a-f0-9]{64}$/.test(a)&&!o.reviewSha256)o.reviewSha256=a.split('=')[1];
    else throw Error('Unsupported argument; identity overrides and collection release forbidden');
  }
  if(o.apply&&!o.reviewSha256)throw Error('Exact reviewed hash required');
  if(o.migration?!!o.out:!o.out||!resolve(o.out).startsWith('/tmp/'))throw Error('Data mode requires new private /tmp output; migration mode is separate');
  return o;
}
async function checked(q,label){const r=await q;if(r.error)throw Error(`${label} unavailable (${r.error.code})`);return r.data;}
async function rows(db,table,filter){
  const all=[];
  for(let n=0;n<10000;n+=500){
    const page=await checked(filter(db.from(table).select('*')).order('id').range(n,n+499),table);
    all.push(...page);if(page.length<500)return all;
  }throw Error('Database pagination limit');
}
export async function readAdoptionEvidence(db,{transport=fetch}={}){
  const member=await checked(db.from('member').select('*').eq('tenant_id',TENANT_ID).eq('id',MEMBER_ID).single(),'member');
  const fields=await rows(db,'preference_field',q=>q.eq('tenant_id',TENANT_ID).eq('name','member_class').eq('entity_scope','member').eq('is_active',true));
  if(fields.length!==1)throw Error('Member class field ambiguous');
  const classes=await rows(db,'member_preference_value',q=>q.eq('member_id',MEMBER_ID).eq('field_id',fields[0].id));
  const configs=await rows(db,'membership_tier_config',q=>q.eq('tenant_id',TENANT_ID));
  const config=configs.find(c=>c.id===STRUCTURE_ID);
  const same=(a,b)=>String(a??'').trim().toLowerCase()===String(b??'').trim().toLowerCase();
  const scopeConfigCount=configs.filter(c=>c.is_active!==false&&c.dd_enabled
    &&same(c.structure_scope_type,config?.structure_scope_type)&&same(c.structure_field_id,config?.structure_field_id)
    &&same(c.structure_match_value,config?.structure_match_value)&&same(c.start_mode,config?.start_mode)
    &&(!c.effective_from||c.effective_from<=CUTOVER)&&(!c.effective_to||c.effective_to>=CUTOVER)).length;
  const dd=buildPilotSnapshot(config);
  const price=await resolveDynamicCollectionPrice({tenant_id:TENANT_ID,member_id:MEMBER_ID,metadata:{dd}},CUTOVER,{db});
  const get=providerReader(await getTenantGocardlessCredentials(TENANT_ID,{db}),transport);
  const mandate=(await get(`mandates/${MANDATE_ID}`)).mandates;
  const customer=(await get(`customers/${CUSTOMER_ID}`)).customers;
  const subscriptions=await readAllProviderPages(get,'subscriptions',{mandate:MANDATE_ID});
  const payments=await readAllProviderPages(get,'payments',{mandate:MANDATE_ID});
  const tokens=await checked(db.from('xero_token').select('tenant_id,access_token,expires_at').eq('app_tenant_id',TENANT_ID),'Xero credentials');
  if(tokens.length!==1||tokens[0].tenant_id!=='3d57dce6-2205-462f-abf6-9c7cbf00be23'
    ||!Number.isFinite(Date.parse(tokens[0].expires_at))||Date.parse(tokens[0].expires_at)<Date.now()+60000)throw Error('Pinned unexpired Xero authentication required');
  const futureInvoices=[];
  let complete=false;
  for(let page=1;page<=100;page++){
    const url=new URL('https://api.xero.com/api.xro/2.0/Invoices');
    url.searchParams.set('where','Contact.ContactID==Guid("3e69cfdf-4d7c-4d70-9630-aa68f8c8fced")');
    url.searchParams.set('page',String(page));
    const r=await transport(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${tokens[0].access_token}`,'Xero-tenant-id':tokens[0].tenant_id,Accept:'application/json'}});
    if(!r.ok)throw Error(`Xero invoice read failed HTTP ${r.status}`);
    const invoices=(await r.json()).Invoices;
    if(!Array.isArray(invoices))throw Error('Xero invoice pagination incomplete');
    for(const i of invoices){
      if(['DELETED','VOIDED'].includes(i.Status))continue;
      if(i.Contact?.ContactID!=='3e69cfdf-4d7c-4d70-9630-aa68f8c8fced'||!i.DateString)throw Error('Xero contact/date evidence mismatch');
      if(i.DateString.slice(0,10)>=CUTOVER||Number(i.AmountDue)>0)futureInvoices.push({id:i.InvoiceID,status:i.Status,date:i.DateString});
    }
    if(invoices.length<100){complete=true;break;}
  }
  if(!complete)throw Error('Xero invoice pagination limit');
  const evidence={member,classes,config,scopeConfigCount,price,mandate,customer,subscriptions,payments,futureInvoices,today:new Date().toISOString().slice(0,10)};
  adoptionManifest(evidence);
  return evidence;
}
export async function main(args=process.argv.slice(2),env=process.env){
  const o=parseAdoptionArgs(args),sql=await readFile(MIGRATION,'utf8'),migrationHash=createHash('sha256').update(sql).digest('hex');
  if(o.migration&&!o.apply){console.log(JSON.stringify({mode:'migration_review',hash:migrationHash,writes:0}));return;}
  if(o.migration&&o.reviewSha256!==migrationHash)throw Error('Migration hash mismatch');
  destinationTarget(env);
  let evidence;
  if(!o.migration){
    if(!env.DEST_SUPABASE_KEY)throw Error('Destination service credential required');
    const db=createClient(env.DEST_SUPABASE_URL,env.DEST_SUPABASE_KEY,{auth:{persistSession:false}});
    const tenant=await checked(db.from('tenant').select('id,name').eq('id',TENANT_ID).single(),'tenant');
    if(!/\bbnms\b|british nuclear medicine society/i.test(tenant.name))throw Error('Destination tenant mismatch');
    evidence=await readAdoptionEvidence(db);
  }
  const client=await destinationConnection(env),report=o.out?await open(resolve(o.out),'wx',0o600):null;
  try{
    await client.connect();await client.query("SET statement_timeout='120s'");await client.query("SET lock_timeout='10s'");
    let result;
    if(o.migration){
      await client.query('BEGIN');try{await client.query(sql);await client.query('COMMIT');}
      catch(e){await client.query('ROLLBACK');throw e;}
      result={mode:'migration_applied',hash:migrationHash};
    }else{
      result=await adoptPilot(client,evidence,{apply:o.apply,reviewSha256:o.reviewSha256,verifiedDestination:true});
      await report.writeFile(JSON.stringify({...result,evidence,remainingGates:[
        'Verify deployed accounting worker support for saved Xero bank AccountID d115eacc-1fa7-476d-844e-d3d7f07f5db5 and revenue200; Stripe fallback forbidden',
        'Published build and database dynamic collection/renewal RPC readiness must be verified',
        'Separate reviewed release must recheck October1 notice deadline, invoices, subscriptions and pending payments',
        'Six-hourly reconciliation cadence must reach the provider submission window; do not silently shift October1',
      ]},null,2));
    }
    console.log(JSON.stringify({mode:result.mode,hash:result.hash,writes:result.writes,collectionReleaseRequired:true,providerWrites:0}));
  }finally{await client.end();await report?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(`BNMS held adoption failed: ${e.code||e.name}; no collection release is implemented.`);process.exitCode=1;});