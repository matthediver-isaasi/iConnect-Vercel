// Supplement only Contacts GETs. Original cached invoices are identity evidence,
// never refreshed, revalidated for settlement, linked to the new term or mutated.
import {readFile,writeFile} from 'node:fs/promises';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {hash,TENANT_ID} from './bnms-dd-beta-invoices.mjs';
const args=process.argv.slice(2);
if(args.length>1||(args.length&&!/^--out-dir=exports\/private-bnms-manual-phase2-refresh-[a-zA-Z0-9-]+$/.test(args[0])))throw Error('Private refresh directory required');
const dir=args[0]?.slice('--out-dir='.length)||'exports/private-bnms-manual-phase2';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const xero=await load(`${dir}/xero-contacts-accounts.json`);
const original=await load('exports/private-bnms-alpha-final-review-20260920/manifest.json');
const cached=await load('exports/private-bnms-alpha-20260920-verified/accounting-evidence.json');
if(hash(original)!=='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a'
 ||hash(cached)!==original.accountingSha256||!xero.complete)throw Error('Pinned original accounting and complete email scan required');
const {members}= (await load(`${dir}/accounting-review.json`)).report;
const p=(await load(`${dir}/gocardless.json`)).discovery;
const identityProofs=members.map(m=>{
 const links=[];
 for(const pay of p.payments.filter(v=>v.links?.mandate===m.mandateId&&v.status==='paid_out'&&!v.amount_refunded)){
  const invoices=cached.invoices.filter(inv=>inv.InvoiceNumber===pay.metadata?.['Invoice number']
   &&inv.CurrencyCode===pay.currency&&inv.Payments?.some(x=>x.Reference===pay.id&&Math.round(Number(x.Amount)*100)===pay.amount));
  if(invoices.length>1)throw Error('Cached exact provider payment association ambiguous');
  if(invoices.length===1){
   const inv=invoices[0],payment=inv.Payments.find(x=>x.Reference===pay.id&&Math.round(Number(x.Amount)*100)===pay.amount);
   links.push({providerPaymentId:pay.id,cachedInvoiceId:inv.InvoiceID,xeroPaymentId:payment.PaymentID,
    contactId:inv.Contact.ContactID,invoiceNumber:inv.InvoiceNumber,amountMinor:pay.amount,currency:pay.currency});
  }
 }
 return {memberId:m.memberId,contactIds:[...new Set(links.map(l=>l.contactId))],
  kind:'exact_existing_provider_payment_reference',cachedAccountingSha256:hash(cached),links};
});
const needed=[...new Set(identityProofs.flatMap(v=>v.contactIds))].filter(id=>!xero.contacts.some(c=>c.ContactID===id));
if(needed.some(id=>!/^[0-9a-f-]{36}$/i.test(id)))throw Error('Invalid cached contact identity');
const estimate=Math.ceil(needed.length/15);
if(xero.requests+estimate>20)throw Error('Shared Xero discovery budget exhausted');
console.log(JSON.stringify({priorRequests:xero.requests,additionalContactRequests:estimate,maximumTotalRequests:20,invoiceRequests:0}));
const c=await destinationConnection();
try{
 await c.connect();await c.query('BEGIN READ ONLY');
 const tokens=(await c.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1',[TENANT_ID])).rows;
 await c.query('ROLLBACK');
 if(tokens.length!==1||tokens[0].tenant_id!=='3d57dce6-2205-462f-abf6-9c7cbf00be23'||Date.parse(tokens[0].expires_at)<Date.now()+120000)throw Error('Normal application authentication needed');
 for(let n=0;n<needed.length;n+=15){
  await new Promise(resolve=>setTimeout(resolve,1500));
  const batch=needed.slice(n,n+15),url=new URL('https://api.xero.com/api.xro/2.0/Contacts');
  url.searchParams.set('IDs',batch.join(','));url.searchParams.set('includeArchived','true');url.searchParams.set('page','1');
  xero.requests++;
  const response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(25000),
   headers:{Authorization:`Bearer ${tokens[0].access_token}`,'xero-tenant-id':tokens[0].tenant_id,Accept:'application/json'}});
  if(!response.ok){xero.supplementStop={status:response.status,retryAfter:response.headers.get('retry-after')};throw Error(`Contacts GET stopped HTTP ${response.status}; no retry`);}
  const body=await response.json();
  if(!Array.isArray(body.Contacts)||body.Contacts.length>batch.length||body.Contacts.some(v=>!batch.includes(v.ContactID))
    ||new Set(body.Contacts.map(v=>v.ContactID)).size!==body.Contacts.length)throw Error('Exact Contacts response identity mismatch');
  xero.contacts.push(...body.Contacts);
 }
 xero.bindings=members.map(m=>{
  const proof=identityProofs.find(v=>v.memberId===m.memberId);
  const emailMatch=xero.matches.find(v=>v.memberId===m.memberId);
  const historical=proof.contactIds.map(id=>xero.contacts.find(c=>c.ContactID===id)).filter(c=>c?.ContactStatus==='ACTIVE');
  const emailCandidates=emailMatch.candidateIds.map(id=>xero.contacts.find(c=>c.ContactID===id)).filter(c=>c?.ContactStatus==='ACTIVE');
  let contact=null,provenance=null;
  if(proof.contactIds.length===1&&historical.length===1){
   contact=historical[0];provenance=proof;
  }else if(!proof.contactIds.length&&emailCandidates.length===1){
   contact=emailCandidates[0];provenance={kind:'unique_current_member_or_attested_gc_email'};
  }
  return {memberId:m.memberId,contactId:contact?.ContactID||null,contactEmail:contact?.EmailAddress?.trim().toLowerCase()||null,
   provenance,status:contact?.EmailAddress?'bound':'needs_review',emailCandidateCount:emailCandidates.length,
   historicalContactCount:proof.contactIds.length};
 });
 const contactIds=xero.bindings.filter(b=>b.status==='bound').map(b=>b.contactId);
 const duplicates=contactIds.filter((id,i)=>contactIds.indexOf(id)!==i);
 if(duplicates.length)throw Error('Cross-member exact Xero contact ownership collision');
 xero.contactBindingsComplete=xero.bindings.every(b=>b.status==='bound');
 xero.completedAt=new Date().toISOString();
 await writeFile(`${dir}/xero-exact-contact-bindings.json`,JSON.stringify(xero,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({requests:xero.requests,invoiceRequests:0,bound:xero.bindings.filter(b=>b.status==='bound').length,
  unresolved:xero.bindings.filter(b=>b.status!=='bound').length,
  byEvidence:Object.fromEntries([...new Set(xero.bindings.map(b=>b.provenance?.kind||'unresolved'))].map(k=>[k,xero.bindings.filter(b=>(b.provenance?.kind||'unresolved')===k).length])),
  bankVerified:xero.bankVerified,evidenceSha256:hash(xero)}));
}catch(error){
 await writeFile(`${dir}/xero-exact-contact-stop.json`,JSON.stringify({requests:xero.requests,error:error.message,stop:xero.supplementStop||null},null,2),{mode:0o600});
 console.log(JSON.stringify({stopped:true,requests:xero.requests,invoiceRequests:0,error:error.message}));process.exitCode=1;
}finally{await c.end();}