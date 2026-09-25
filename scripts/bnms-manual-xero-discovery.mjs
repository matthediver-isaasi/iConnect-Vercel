// Only Connections, Contacts and Accounts GETs. Never refreshes tokens or reads invoices.
import {readFile,writeFile} from 'node:fs/promises';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {TENANT_ID,hash} from './bnms-dd-beta-invoices.mjs';
const args=process.argv.slice(2);
if(args.length>1||(args.length&&!/^--out-dir=exports\/private-bnms-manual-phase2-refresh-[a-zA-Z0-9-]+$/.test(args[0])))throw Error('Private refresh directory required');
const dir=args[0]?.slice('--out-dir='.length)||'exports/private-bnms-manual-phase2';
const evidence=JSON.parse(await readFile(`${dir}/accounting-review.json`,'utf8')).report;
const {snapshot:s}=JSON.parse(await readFile(`${dir}/destination.json`,'utf8'));
const {discovery:p}=JSON.parse(await readFile(`${dir}/gocardless.json`,'utf8'));
const normalize=v=>String(v||'').trim().toLowerCase();
const emails=[...new Set(evidence.members.flatMap(m=>[
 normalize(s.members.find(x=>x.id===m.memberId)?.email),
 normalize(p.customers.find(x=>x.id===m.customerId)?.email),
]).filter(Boolean))].sort();
const batches=Array.from({length:Math.ceil(emails.length/15)},(_,i)=>emails.slice(i*15,i*15+15));
console.log(JSON.stringify({mode:'readonly_budget',estimatedRequests:2+batches.length,maxRequests:20,paceMs:1500,invoiceEndpointsForbidden:true}));
const report={observedAt:new Date().toISOString(),requests:0,contacts:[],connections:[],accounts:[],complete:false};
const save=async()=>writeFile(`${dir}/xero-contacts-accounts.json`,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
const c=await destinationConnection();
try{
 await c.connect();await c.query('BEGIN READ ONLY');
 const tokens=(await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1',[TENANT_ID])).rows;
 await c.query('ROLLBACK');
 if(tokens.length!==1||tokens[0].tenant_id!=='3d57dce6-2205-462f-abf6-9c7cbf00be23'||Date.parse(tokens[0].expires_at)<Date.now()+120000)throw Error('Existing Xero authentication expired or insufficient lifetime; no refresh attempted');
 const get=async(url)=>{
  const parsed=new URL(url);
  if(parsed.origin!=='https://api.xero.com'||!['/connections','/api.xro/2.0/Contacts','/api.xro/2.0/Accounts'].includes(parsed.pathname))throw Error('Forbidden Xero endpoint');
  if(report.requests>=20)throw Error('Xero request budget exhausted');
  if(report.requests)await new Promise(resolve=>setTimeout(resolve,1500));
  report.requests++;
  const response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(25000),headers:{
   Authorization:`Bearer ${tokens[0].access_token}`,'xero-tenant-id':tokens[0].tenant_id,Accept:'application/json'}});
  if(!response.ok){report.stop={status:response.status,retryAfter:response.headers.get('retry-after')};throw Error(`Xero GET stopped HTTP ${response.status}; no retry`);}
  return response.json();
 };
 report.connections=await get('https://api.xero.com/connections');
 if(!Array.isArray(report.connections)||!report.connections.some(x=>x.tenantId===tokens[0].tenant_id))throw Error('Pinned Xero connection missing');
 const accountBody=await get('https://api.xero.com/api.xro/2.0/Accounts');
 if(!Array.isArray(accountBody.Accounts))throw Error('Malformed accounts');
 report.accounts=accountBody.Accounts;
 for(const batch of batches){
  for(let page=1;;page++){
   const url=new URL('https://api.xero.com/api.xro/2.0/Contacts');
   url.searchParams.set('where',batch.map(email=>`EmailAddress==${JSON.stringify(email)}`).join(' OR '));
   url.searchParams.set('page',String(page));url.searchParams.set('includeArchived','true');
   const body=await get(url);
   if(!Array.isArray(body.Contacts))throw Error('Malformed contacts');
   if(body.Contacts.some(c=>!batch.includes(normalize(c.EmailAddress))))throw Error('Contact filter response mismatch');
   if(body.Contacts.some(c=>report.contacts.some(x=>x.ContactID===c.ContactID)))throw Error('Repeated contact page');
   report.contacts.push(...body.Contacts);
   if(body.Contacts.length<100)break;
  }
 }
 report.complete=true;report.completedAt=new Date().toISOString();
 const bank=report.accounts.find(a=>a.AccountID==='d115eacc-1fa7-476d-844e-d3d7f07f5db5');
 report.bankVerified=bank?.Status==='ACTIVE'&&bank?.Type==='BANK'&&bank?.CurrencyCode==='GBP';
 report.matches=evidence.members.map(m=>{
  const allowed=emails.filter(email=>email===normalize(s.members.find(x=>x.id===m.memberId)?.email)||email===normalize(p.customers.find(x=>x.id===m.customerId)?.email));
  const candidates=report.contacts.filter(x=>allowed.includes(normalize(x.EmailAddress))&&x.ContactStatus==='ACTIVE');
  return {memberId:m.memberId,candidateIds:candidates.map(x=>x.ContactID)};
 });
 report.crossOwnerContacts=[...new Set(report.matches.flatMap(m=>m.candidateIds))].filter(id=>report.matches.filter(m=>m.candidateIds.includes(id)).length>1);
 await save();
 console.log(JSON.stringify({complete:true,requests:report.requests,bankVerified:report.bankVerified,
  unique:report.matches.filter(m=>m.candidateIds.length===1).length,missing:report.matches.filter(m=>!m.candidateIds.length).length,
  ambiguous:report.matches.filter(m=>m.candidateIds.length>1).length,crossOwnerContacts:report.crossOwnerContacts.length,evidenceSha256:hash(report)}));
}catch(error){report.error=error.message;await save();console.log(JSON.stringify({complete:false,requests:report.requests,error:report.error}));process.exitCode=1;}
finally{await c.end();}