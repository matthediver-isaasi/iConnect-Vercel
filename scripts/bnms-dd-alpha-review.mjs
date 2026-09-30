#!/usr/bin/env node
// Complete, private, read-only account discovery. Never adopts or releases.
import { readFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { TENANT_ID, MEMBER_ID, WORKBOOK_SHA256, digest, validateGrid, readAllProviderPages } from './bnms-dd-pilot.mjs';
import { matchingStructures } from './bnms-dd-beta-review.mjs';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
import { XERO_TENANT_ID, hash, reconcileHistoricalInvoices } from './bnms-dd-beta-invoices.mjs';
export const FROM='2026-01-01', START='2026-10-01', END='2027-09-30';
export const CREDITOR='CR0000B50W1Y2R';
const norm=v=>String(v||'').trim().toLowerCase();
export const stableId=(type,id)=>{
  const h=createHash('sha256').update(`bnms-alpha-v1:${type}:${id}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
export function alphaProviderReader(credentials,transport=fetch){
  if(credentials.source!=='tenant'||credentials.tenantId!==TENANT_ID||credentials.environment!=='live'
    ||!credentials.accessToken||credentials.accessToken.startsWith('sandbox_'))throw Error('Pinned live tenant credentials required');
  return async(resource,query={})=>{
    if(!/^(customers|mandates|payments|subscriptions)(\/[A-Z0-9]+)?$/.test(resource))throw Error('Read-only provider allowlist');
    const url=new URL(`https://api.gocardless.com/${resource}`);
    for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
    const r=await transport(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${credentials.accessToken}`,'GoCardless-Version':'2015-07-06'}});
    if(!r.ok)throw Error(`GC read HTTP ${r.status}`);
    return r.json();
  };
}
export async function snapshotDestination(c){
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    const rows=async(sql,args=[TENANT_ID])=>(await c.query(sql,args)).rows;
    const s={
      members:await rows('SELECT * FROM member WHERE tenant_id=$1'),
      preferences:await rows(`SELECT v.member_id,f.id AS field_id,f.name,v.value FROM member_preference_value v
        JOIN preference_field f ON f.id=v.field_id JOIN member m ON m.id=v.member_id
        WHERE m.tenant_id=$1 AND f.tenant_id=$1 AND f.entity_scope='member' AND f.is_active=true`),
      structures:await rows('SELECT * FROM membership_tier_config WHERE tenant_id=$1'),
      discovery:await rows("SELECT * FROM gocardless_mandate_discovery_row WHERE tenant_id=$1 AND environment='live'"),
      beta:await rows('SELECT member_id,mandate_id,customer_id FROM bnms_dd_beta_adoption WHERE tenant_id=$1'),
      agreements:await rows('SELECT * FROM membership_billing_agreements WHERE tenant_id=$1'),
      plans:await rows('SELECT * FROM membership_payment_plans WHERE tenant_id=$1'),
      history:await rows('SELECT * FROM member_membership_history WHERE tenant_id=$1'),
      xero:await rows('SELECT tenant_id FROM xero_token WHERE app_tenant_id=$1'),
    };
    if(s.beta.length!==10||s.xero.length!==1||s.xero[0].tenant_id!==XERO_TENANT_ID)throw Error('Pinned beta/Xero scope drift');
    return JSON.parse(JSON.stringify(s));
  }finally{await c.query('ROLLBACK');}
}
export function classifyPopulation({grid,snapshot:s,provider:p}){
  validateGrid(grid);
  const sheet=grid.slice(1).map((r,n)=>({group:'spreadsheet',sourceRow:n+2,memberId:String(r[4]).trim(),
    customerId:String(r[5]).trim(),mandateId:String(r[6]).trim(),email:norm(r[3])}));
  const entries=[];
  for(const mandate of p.mandates){
    const customer=p.customers.find(c=>c.id===mandate.links?.customer);
    const matches=sheet.filter(r=>r.mandateId===mandate.id||r.customerId===customer?.id);
    const direct=s.members.filter(m=>norm(m.email)&&norm(m.email)===norm(customer?.email));
    const identity=matches.length===1?matches[0]:matches.length===0&&direct.length===1?
      {group:'direct_match',memberId:direct[0].id,email:norm(direct[0].email),mandateId:mandate.id,customerId:customer.id}:null;
    const reasons=[];
    const excluded=mandate.id==='MD00330XE0B797'||customer?.id==='CU00426EF15CE5'||identity?.memberId===MEMBER_ID
      ||s.beta.some(b=>b.member_id===identity?.memberId||b.mandate_id===mandate.id||b.customer_id===customer?.id);
    if(excluded){entries.push({mandateId:mandate.id,identity,disposition:'excluded_pilot_beta',reasons:[]});continue;}
    if(mandate.status!=='active')reasons.push('MANDATE_NOT_ACTIVE');
    if(mandate.links?.creditor!==CREDITOR)reasons.push('CREDITOR_NOT_PINNED');
    if(!customer||!identity||identity.mandateId!==mandate.id||identity.customerId!==customer.id)reasons.push('IDENTITY_MISSING_OR_AMBIGUOUS');
    const member=s.members.find(m=>m.id===identity?.memberId);
    if(!member||member.tenant_id!==TENANT_ID||norm(member.email)!==identity?.email||!identity?.email
      ||s.members.filter(m=>norm(m.email)===identity?.email).length!==1
      ||member.membership_paused||member.is_deleted||member.deleted_at
      ||['cancelled','paused','deleted'].includes(member.status))reasons.push('MEMBER_IDENTITY_OR_STATE_CONFLICT');
    if(identity&&s.discovery.some(d=>(d.gocardless_mandate_id===mandate.id||d.gocardless_customer_id===customer?.id)
      &&d.matched_member_id&&d.matched_member_id!==identity.memberId))reasons.push('DISCOVERY_OWNER_CONFLICT');
    const preferences=s.preferences.filter(v=>v.member_id===member?.id);
    const structures=matchingStructures(s.structures,preferences.filter(v=>v.name==='member_class'),START);
    if(structures.length!==1)reasons.push('PRICING_STRUCTURE_MISSING_OR_AMBIGUOUS');
    const structure=structures[0];
    if(structure&&(structure.currency!=='GBP'||structure.pricing_model!=='flat'||structure.start_mode!=='immediate'
      ||structure.dd_invoicing_mode!=='per_instalment'||!Number.isFinite(Number(structure.dd_monthly_amount))
      ||Number(structure.dd_monthly_amount)<=0))reasons.push('UNSUPPORTED_PRICING_STRUCTURE');
    if(member&&['agreements','plans','history'].some(k=>s[k].some(r=>r.member_id===member.id
      ||r.gocardless_mandate_id===mandate.id)))reasons.push('EXISTING_CANONICAL_RECORD_REQUIRES_REVIEW');
    const subscriptions=p.subscriptions.filter(x=>x.links?.mandate===mandate.id);
    if(subscriptions.length)reasons.push('PROVIDER_SUBSCRIPTION_REQUIRES_HANDOVER');
    const payments=p.payments.filter(x=>x.links?.mandate===mandate.id);
    if(payments.some(x=>['pending_submission','submitted','confirmed'].includes(x.status)||x.charge_date>=START))
      reasons.push('PENDING_OR_FUTURE_PAYMENT_REQUIRES_REVIEW');
    const historical=payments.filter(x=>x.status==='paid_out'&&x.charge_date>=FROM&&x.charge_date<START);
    if(!historical.length)reasons.push('NO_SETTLED_HISTORY_IN_WINDOW');
    // We deliberately do not infer a current entitlement from recurring payments,
    // a legacy expiry field or the user's separate approval of the future term.
    entries.push({mandateId:mandate.id,identity,member,customer,mandate,preferences,structure,
      subscriptions,payments,historical,priorEntitlement:{verified:false,start:null,end:null},
      disposition:'review',reasons});
  }
  for(const e of entries.filter(e=>e.disposition==='review'&&e.identity)){
    if(entries.filter(x=>x.identity&&(x.identity.memberId===e.identity.memberId
      ||x.identity.customerId===e.identity.customerId)).length!==1)e.reasons.push('MULTIPLE_MANDATES_OR_MEMBER_IDENTITIES');
  }
  for(const row of sheet.filter(r=>!p.mandates.some(m=>m.id===r.mandateId)))
    entries.push({identity:row,mandateId:row.mandateId,disposition:'review',reasons:['WORKBOOK_MANDATE_MISSING_FROM_COMPLETE_LIVE_ACCOUNT']});
  return entries;
}
export async function privateJson(path,value){
  const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2));}finally{await f.close();}
}
export async function main(args=process.argv.slice(2)){
  if(args.length!==2||!['--out-dir','--resume-out-dir'].includes(args[0])||!resolve(args[1]).startsWith(`${resolve('exports')}/`))
    throw Error('Use --out-dir or --resume-out-dir exports/private-directory; no apply mode');
  destinationTarget(process.env);
  const {supabaseUrl}=await import('../api/_lib/database.js');
  if(supabaseUrl!==process.env.DEST_SUPABASE_URL)throw Error('Use run-bnms-dd-alpha-review.mjs pinned DEST bootstrap');
  const out=resolve(args[1]);await mkdir(out,{recursive:true,mode:0o700});
  const bytes=await readFile(new URL('../attached_assets/DD_matched_different_emails_1789802289108.xlsx',import.meta.url));
  if(digest(bytes)!==WORKBOOK_SHA256)throw Error('Workbook fingerprint drift');
  const wb=XLSX.read(bytes,{type:'buffer'});
  if(wb.SheetNames.length!==1)throw Error('Workbook shape drift');
  const grid=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''});
  validateGrid(grid);
  let evidence;
  if(args[0]==='--resume-out-dir'){
    evidence=JSON.parse(await readFile(`${out}/source-evidence.json`,'utf8'));
    if(evidence.workbookSha256!==WORKBOOK_SHA256||hash(evidence.grid)!==hash(grid)
      ||evidence.tenantId!==TENANT_ID||evidence.completeAccountDiscovery!==true)throw Error('Resume source drift');
  }else{
    const c=await destinationConnection();await c.connect();let snapshot;
    try{snapshot=await snapshotDestination(c);}finally{await c.end();}
    const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const get=alphaProviderReader(await getTenantGocardlessCredentials(TENANT_ID,{db}));
    const provider={};
    for(const resource of ['customers','mandates','subscriptions','payments']){
      provider[resource]=await readAllProviderPages(get,resource);
      console.log(JSON.stringify({resource,count:provider[resource].length,pagination:'exhausted'}));
    }
    evidence={version:1,tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,observedAt:new Date().toISOString(),
      workbookSha256:WORKBOOK_SHA256,grid,snapshot,provider,completeAccountDiscovery:true};
    await privateJson(`${out}/source-evidence.json`,evidence);
  }
  const {provider}=evidence;
  const entries=classifyPopulation(evidence);
  if(args[0]==='--out-dir')await privateJson(`${out}/population-review.json`,entries);
  // Only identity-verified, unique, active mandates are eligible for financial
  // lookup; preserve every other exception explicitly rather than guessing.
  const financial=entries.filter(e=>e.historical?.length&&!e.reasons.some(r=>
    ['IDENTITY_MISSING_OR_AMBIGUOUS','MEMBER_IDENTITY_OR_STATE_CONFLICT','MULTIPLE_MANDATES_OR_MEMBER_IDENTITIES',
      'MANDATE_NOT_ACTIVE','CREDITOR_NOT_PINNED','DISCOVERY_OWNER_CONFLICT'].includes(r)));
  process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
  const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
  const auth=await getValidXeroAccessToken(TENANT_ID);
  if(auth.tenantId!==XERO_TENANT_ID)throw Error('Xero tenant mismatch');
  const xget=async(resource,query={})=>{
    const url=new URL(`https://api.xero.com/api.xro/2.0/${resource}`);
    for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
    const r=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${auth.accessToken}`,'Xero-tenant-id':auth.tenantId,Accept:'application/json'}});
    if(!r.ok)throw Error(`Xero read HTTP ${r.status}`);
    const body=await r.json();await new Promise(r=>setTimeout(r,1100));return body;
  };
  const numbers=[...new Set(financial.flatMap(e=>e.historical.map(p=>p.metadata?.['Invoice number'])).filter(n=>/^INV-\d+$/.test(n)))];
  const invoices=[];
  for(let n=0;n<numbers.length;n+=25){
    const cache=`${out}/invoices-${n}.json`,identity=hash(numbers.slice(n,n+25));
    try{
      const saved=JSON.parse(await readFile(cache,'utf8'));
      if(saved.identity!==identity)throw Error('Invoice checkpoint drift');
      invoices.push(...saved.invoices);continue;
    }catch(e){if(e.code!=='ENOENT')throw e;}
    const chunk=[];
    for(let page=1;page<=1000;page++){
      const data=await xget('Invoices',{InvoiceNumbers:numbers.slice(n,n+25).join(','),page:String(page),pageSize:'100'});
      if(!Array.isArray(data.Invoices))throw Error('Incomplete Xero invoice pagination');
      chunk.push(...data.Invoices);
      if(data.Invoices.length<100)break;
      if(page===1000)throw Error('Xero invoice pagination bound');
    }
    await privateJson(cache,{identity,invoices:chunk});
    invoices.push(...chunk);
    console.log(JSON.stringify({invoiceNumbersRead:Math.min(n+25,numbers.length),total:numbers.length}));
  }
  const contacts=[];
  for(const id of new Set(invoices.map(i=>i.Contact?.ContactID))){
    if(!/^[0-9a-f-]{36}$/i.test(id))throw Error('Invalid Xero contact identity');
    const cache=`${out}/contact-${id}.json`;
    try{contacts.push(JSON.parse(await readFile(cache,'utf8')));continue;}catch(e){if(e.code!=='ENOENT')throw e;}
    const data=await xget(`Contacts/${id}`);
    if(data.Contacts?.length!==1)throw Error('Ambiguous Xero contact');
    await privateJson(cache,data.Contacts[0]);
    contacts.push(data.Contacts[0]);
  }
  const accounting={invoices:[...new Map(invoices.map(i=>[i.InvoiceID,i])).values()],contacts};
  await privateJson(`${out}/accounting-evidence.json`,accounting);
  for(const e of financial){
    const rows=e.historical.map(p=>({id:stableId('payment',p.id),tenant_id:TENANT_ID,member_id:e.member.id,
      mandate_id:e.mandate.id,customer_id:e.customer.id,email:e.member.email,provider_payment_id:p.id,
      charge_date:p.charge_date,amount_minor:p.amount,currency:p.currency,evidence:p}));
    try{e.links=reconcileHistoricalInvoices({tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,rows,
      provider:[{mandate:e.mandate,customer:e.customer,payments:e.historical}],...accounting});
      e.invoiceReconciliation='complete';}
    catch(error){e.invoiceReconciliation='blocked';e.reasons.push(`INVOICE_RECONCILIATION: ${error.message}`);}
  }
  const report={version:1,tenantId:TENANT_ID,observedAt:evidence.observedAt,sourceSha256:hash(evidence),
    accountingSha256:hash(accounting),from:FROM,cutover:START,collectionHeld:true,releaseApproved:false,
    completeAccountDiscovery:true,counts:Object.fromEntries(Object.entries(provider).map(([k,v])=>[k,v.length])),
    entries,readyToImport:false,writes:0,providerWrites:0};
  await privateJson(`${out}/reviewed-report.json`,report);
  console.log(JSON.stringify({mode:'read_only_alpha_review',counts:report.counts,financialMembers:financial.length,
    reconciled:financial.filter(e=>e.invoiceReconciliation==='complete').length,
    excluded:entries.filter(e=>e.disposition==='excluded_pilot_beta').length,
    reasons:entries.reduce((a,e)=>{for(const r of e.reasons)a[r]=(a[r]||0)+1;return a;},{}),
    reportSha256:hash(report),out,writes:0,providerWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{
  console.error(JSON.stringify({error:e.message,importWrites:0}));process.exitCode=1;
});