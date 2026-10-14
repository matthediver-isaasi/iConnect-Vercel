// Read-only Xero evidence. The sole credential write permitted is the normal
// application's OAuth refresh. Never invokes financial or membership writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const dir='generated-artifacts/bnms-live-xero-150';
fs.mkdirSync(`${dir}/cache`,{recursive:true,mode:0o700});
const sha=x=>createHash('sha256').update(x).digest('hex');
const save=(name,x)=>fs.writeFileSync(`${dir}/${name}`,JSON.stringify(x,null,2),{mode:0o600});
const bytes=fs.readFileSync('generated-artifacts/bnms-missing-150-review/snapshot.json');
const snapshot=JSON.parse(bytes);
assert.equal(snapshot.members.length,150);
assert.equal(snapshot.tenant,'ff2df806-b321-4254-b651-3af11fccf1db');
const pin={snapshotHash:sha(bytes),tenant:snapshot.tenant};
if(fs.existsSync(`${dir}/pin.json`))assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/pin.json`)),pin);
else save('pin.json',pin);
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
let requests=0,lastRequest=0,auth,authTime=0,remainingDay=null,remainingMinute=null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function get(resource,params={}){
  const url=`${resource}?${new URLSearchParams(params)}`;
  const file=`${dir}/cache/${sha(url)}.json`;
  if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file)).body;
  assert.ok(requests<600,'Request safety budget exceeded');
  if(remainingDay!==null&&remainingDay<500)throw Error('DAILY_RESERVE_REACHED');
  if(remainingMinute!==null&&remainingMinute<15){await sleep(65000);remainingMinute=null;}
  await sleep(Math.max(0,2100-(Date.now()-lastRequest)));
  if(!auth||Date.now()-authTime>10*60*1000){
    auth=await getValidXeroAccessToken(snapshot.tenant);authTime=Date.now();
    assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
  }
  lastRequest=Date.now();requests++;
  const response=await fetch(`https://api.xero.com/api.xro/2.0/${url}`,{
    headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
    signal:AbortSignal.timeout(30000)});
  const number=name=>response.headers.has(name)?Number(response.headers.get(name)):null;
  remainingDay=number('x-daylimit-remaining');remainingMinute=number('x-minlimit-remaining');
  save('progress.json',{at:new Date().toISOString(),requests,remainingDay,remainingMinute,
    status:response.status,financialWrites:0,membershipWrites:0});
  if(!response.ok)throw Error(`HTTP_${response.status}`);
  const body=await response.json();
  fs.writeFileSync(file,JSON.stringify({url,capturedAt:new Date().toISOString(),body}),{mode:0o600,flag:'wx'});
  return body;
}
async function pages(resource,params,key){
  const rows=[],seen=new Set();
  for(let page=1;page<=100;page++){
    const body=await get(resource,{...params,page:String(page)});
    assert.ok(Array.isArray(body[key]),'Incomplete provider response');
    for(const row of body[key]){
      const id=row[key==='Contacts'?'ContactID':'InvoiceID'];assert.ok(id&&!seen.has(id),'Duplicate provider pagination');
      seen.add(id);rows.push(row);
    }
    if(body[key].length<100)return rows;
  }
  throw Error('PAGINATION_INCOMPLETE');
}
const memberInvoice=i=>(i.LineItems||[]).some(l=>/\bmembership\b|\b(?:full|associate|trainee|student|retired|overseas|honorary|LMIC)[ -]+member\b/i.test(l.Description||''));
try{
  const contacts=new Map();
  for(let i=0;i<snapshot.source.length;i+=20){
    const batch=snapshot.source.slice(i,i+20);
    const accounts=batch.map(s=>s.preferences.ym_web_site_member_id.trim());
    assert.ok(accounts.every(a=>/^\d+$/.test(a)));
    for(const c of await pages('Contacts',{where:accounts.map(a=>`AccountNumber==${JSON.stringify(a)}`).join(' OR '),includeArchived:'true'},'Contacts'))
      contacts.set(c.ContactID,c);
    console.log(`CONTACTS ${Math.min(i+20,150)}/150; requests=${requests}`);
  }
  for(let i=0;i<snapshot.members.length;i+=20){
    const emails=snapshot.members.slice(i,i+20).map(m=>m.email.trim().toLowerCase());
    for(const c of await pages('Contacts',{where:emails.map(e=>`EmailAddress==${JSON.stringify(e)}`).join(' OR '),includeArchived:'true'},'Contacts'))
      contacts.set(c.ContactID,c);
  }
  const archiveInvoices=[];
  const numbers=[...new Set(snapshot.invoices.map(i=>i.invoice_number).filter(n=>/^[A-Za-z0-9-]+$/.test(n)))];
  for(let i=0;i<numbers.length;i+=20){
    const batch=numbers.slice(i,i+20);
    const found=await pages('Invoices',{where:batch.map(n=>`InvoiceNumber==${JSON.stringify(n)}`).join(' OR ')},'Invoices');
    assert.ok(found.every(v=>batch.includes(v.InvoiceNumber)),'Invoice number filter ignored');
    archiveInvoices.push(...found);
    console.log(`ARCHIVE_REFERENCES ${Math.min(i+20,numbers.length)}/${numbers.length}; requests=${requests}`);
  }
  for(const contactId of [...new Set(archiveInvoices.map(i=>i.Contact.ContactID))]){
    if(contacts.has(contactId))continue;
    const c=(await get(`Contacts/${contactId}`)).Contacts?.[0];
    assert.equal(c?.ContactID,contactId);
    contacts.set(contactId,c);
  }
  save('archive-invoices.json',archiveInvoices);
  const matches=snapshot.members.map(m=>{
    const source=snapshot.source.find(s=>s.id===m.id);
    const knownNumbers=new Set(snapshot.invoices.filter(i=>i.member_id===m.id).map(i=>i.invoice_number));
    const archiveContactIds=archiveInvoices.filter(i=>knownNumbers.has(i.InvoiceNumber)).map(i=>i.Contact.ContactID);
    const found=[...contacts.values()].filter(c=>c.AccountNumber?.trim()===source.preferences.ym_web_site_member_id.trim()
      ||c.EmailAddress?.trim().toLowerCase()===m.email.trim().toLowerCase()||archiveContactIds.includes(c.ContactID));
    const c=found[0];
    const emailMatch=found.length===1&&c.EmailAddress?.trim().toLowerCase()===m.email.trim().toLowerCase();
    const accountMatch=found.length===1&&c.AccountNumber?.trim()===source.preferences.ym_web_site_member_id.trim();
    const archiveMatch=found.length===1&&archiveContactIds.includes(c.ContactID);
    return {memberId:m.id,contacts:found,exact:!!emailMatch&&(accountMatch||archiveMatch),
      emailMatch:!!emailMatch,accountMatch,archiveMatch};
  });
  save('contacts.json',matches);
  // Also inspect account-matched/email-different contacts, but retain identity hold.
  const ids=[...new Set(matches.flatMap(m=>m.contacts.map(c=>c.ContactID)))];
  const invoices=new Map();
  for(let i=0;i<ids.length;i+=15){
    const batch=ids.slice(i,i+15);
    const found=await pages('Invoices',{ContactIDs:batch.join(','),where:'Type=="ACCREC"',order:'Date DESC'},'Invoices');
    for(const invoice of found){
      assert.ok(batch.includes(invoice.Contact?.ContactID),'Provider ignored contact scope');
      assert.ok(!invoices.has(invoice.InvoiceID),'Duplicate invoice across batches');
      invoices.set(invoice.InvoiceID,invoice);
    }
    console.log(`INVOICES ${Math.min(i+15,ids.length)}/${ids.length}; requests=${requests}`);
  }
  save('invoices.json',[...invoices.values()]);
  const results=[];
  for(const match of matches){
    const contactIds=match.contacts.map(c=>c.ContactID);
    const history=[...invoices.values()].filter(i=>contactIds.includes(i.Contact?.ContactID)&&memberInvoice(i))
      .sort((a,b)=>String(b.DateString).localeCompare(String(a.DateString))||a.InvoiceID.localeCompare(b.InvoiceID));
    const latest=history.find(i=>!['VOIDED','DELETED','DRAFT'].includes(i.Status));
    const latestPaid=history.find(i=>i.Status==='PAID');
    const payments=[];
    if(latestPaid)for(const p of latestPaid.Payments||[]){
      const body=await get(`Payments/${p.PaymentID}`);
      assert.equal(body.Payments?.length,1,'Payment detail absent');
      assert.equal(body.Payments[0].PaymentID,p.PaymentID);
      payments.push(body.Payments[0]);
    }
    results.push({...match,membershipInvoices:history,latestInvoiceId:latest?.InvoiceID||null,
      latestPaidInvoiceId:latestPaid?.InvoiceID||null,payments});
    save('members.json',results);
    if(results.length%10===0)console.log(`PAYMENTS ${results.length}/150; requests=${requests}; dayRemaining=${remainingDay}`);
  }
  save('complete.json',{...pin,completedAt:new Date().toISOString(),members:results.length,requests,
    cachedRequests:fs.readdirSync(`${dir}/cache`).length,remainingDay,remainingMinute,financialWrites:0,membershipWrites:0});
  console.log(`AUDIT_COLLECTION_COMPLETE members=${results.length} requests=${requests}`);
}catch(e){
  const code=/HTTP_\d+|DAILY_RESERVE_REACHED|PAGINATION_INCOMPLETE/.exec(String(e.message))?.[0]||e.code||e.name;
  save('stopped.json',{at:new Date().toISOString(),code,requests,financialWrites:0,membershipWrites:0});
  console.error(`AUDIT_STOPPED ${code}; completed requests retained; no financial or membership writes`);
  process.exitCode=1;
}
