// Exact-cohort release. Provider access is GET-only; arming is a separately
// reviewed, serializable database transaction and never creates a payment.
import {readFile} from 'node:fs/promises';
import { hash, sqlHash, assertHistoricalInvoicesComplete } from './bnms-dd-beta-invoices.mjs';
import { TENANT_ID } from './bnms-dd-pilot.mjs';

export const ALPHA_MANIFEST_SHA256='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a';
export const PROCESSING_NOT_BEFORE='2026-09-30T23:00:00Z';
export const MAX_EVIDENCE_AGE_MS=15*60*1000;
export const MIGRATION=new URL('../supabase/migrations/20261117_bnms_dd_alpha_scheduled_release.sql',import.meta.url);
export const INVOICE_MIGRATION=new URL('../supabase/migrations/20261118_bnms_alpha_invoice_operations.sql',import.meta.url);
export const INVOICE_MIGRATION_SHA256='29cb31602c0f7c65ef8bb0ae61789c7f58e0a9b9be84dba30f077014c597928b';
export const ALPHA_BANK_ACCOUNT_ID='d115eacc-1fa7-476d-844e-d3d7f07f5db5';
export const ALPHA_XERO_TENANT_ID='3d57dce6-2205-462f-abf6-9c7cbf00be23';
const fail=message=>{throw Error(message);};
const same=(a,b)=>hash(a)===hash(b);

export async function alphaSchemaBundle(){
  const releaseSql=await readFile(MIGRATION,'utf8'),invoiceSql=await readFile(INVOICE_MIGRATION,'utf8');
  if(sqlHash(invoiceSql)!==INVOICE_MIGRATION_SHA256)fail('Reviewed alpha invoice-operation migration hash differs');
  // The original invoice migration is standalone. Strip only its authenticated
  // outer transaction so both schemas remain inside the caller's ONE transaction.
  if(!/^BEGIN;\s/.test(invoiceSql)||!/\bCOMMIT;\s*$/.test(invoiceSql))
    fail('Expected standalone invoice migration transaction boundaries');
  const migrations=[
    {name:'20261117_bnms_dd_alpha_scheduled_release.sql',sha256:sqlHash(releaseSql)},
    {name:'20261118_bnms_alpha_invoice_operations.sql',sha256:sqlHash(invoiceSql)},
  ];
  return {hash:hash(migrations),migrations,releaseSql,
    invoiceSql:invoiceSql.replace(/^BEGIN;\s*/,'').replace(/\bCOMMIT;\s*$/,'')};
}

export function validateAlphaReleaseScope(manifest,adoptions){
  if(hash(manifest)!==ALPHA_MANIFEST_SHA256||manifest.tenantId!==TENANT_ID
    ||manifest.members.length!==249||manifest.exceptions.length!==170
    ||adoptions.length!==249)fail('Exact immutable 249-member alpha scope required');
  for(const key of ['id','member_id','mandate_id','customer_id','plan_id','agreement_id','history_id']){
    if(adoptions.some(a=>!a[key])||new Set(adoptions.map(a=>a[key])).size!==249)fail(`Alpha duplicate/missing ${key}`);
  }
  for(const a of adoptions){
    const m=manifest.members.find(m=>m.identity.memberId===a.member_id);
    if(!m||a.tenant_id!==TENANT_ID||a.manifest_sha256!==ALPHA_MANIFEST_SHA256
      ||a.evidence_sha256!==hash(m)||!same(a.evidence,m)
      ||a.mandate_id!==m.identity.mandateId||a.customer_id!==m.identity.customerId
      ||a.plan_id!==m.ids.plan||a.agreement_id!==m.ids.agreement||a.history_id!==m.ids.membership
      ||a.id!==m.ids.adoption)fail('Alpha adoption identity/provenance drift');
  }
}

// A staged scan never acquires a new observation time on resume. Final arming
// must use the oldest actual read, including subsequent lock/transaction time.
export function assertAlphaStageFresh(stages,memberIds,instant=new Date()){
  const ids=stages.flatMap(s=>s.memberIds||[]);
  if(!same([...ids].sort(),[...memberIds].sort())||new Set(ids).size!==ids.length)
    fail('Complete non-overlapping alpha evidence stages required');
  const now=instant.getTime();
  if(!Number.isFinite(now)||!stages.length)fail('Valid evidence clock required');
  for(const stage of stages){
    const start=Date.parse(stage.observedAt),end=Date.parse(stage.completedAt);
    if(stage.manifestSha256!==ALPHA_MANIFEST_SHA256||stage.complete!==true
      ||!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now
      ||now-start>MAX_EVIDENCE_AGE_MS)fail('Oldest alpha evidence exceeds 15 minutes or is incomplete');
  }
}

export function validateAlphaHandover(handover,memberIds,instant=new Date()){
  const confirmed=Date.parse(handover?.confirmedAt),now=instant.getTime();
  if(handover?.tenantId!==TENANT_ID||handover.manifestSha256!==ALPHA_MANIFEST_SHA256
    ||handover.automaticLegacyCollectionsDisabled!==true
    ||typeof handover.confirmedBy!=='string'||!handover.confirmedBy.trim()
    ||typeof handover.evidenceReference!=='string'||!handover.evidenceReference.trim()
    ||!Array.isArray(handover.memberIds)||!same([...handover.memberIds].sort(),[...memberIds].sort())
    ||!Number.isFinite(now)||!Number.isFinite(confirmed)||confirmed>now||now-confirmed>86400000)
    fail('Fresh exact-alpha legacy collector handover required; beta confirmation is not alpha approval');
}

export function validateAlphaBankApproval(handover,memberIds,instant=new Date()){
  validateAlphaHandover(handover,memberIds,instant);
  const approval=handover.accountingApproval;
  if(!approval||approval.bankAccountId!==ALPHA_BANK_ACCOUNT_ID
    ||approval.xeroTenantId!==ALPHA_XERO_TENANT_ID
    ||approval.bankName!=='GoCardless-GBP'||approval.approved!==true)
    fail('Explicit exact-alpha GoCardless-GBP accounting approval required');
}

export function prepareAlphaRelease({manifest,adoptions,historical,links,canonical,handover=null,observedAt,completedAt}){
  validateAlphaReleaseScope(manifest,adoptions);
  if(historical.length!==2137||links.length!==2137)fail('Exact 2137 historical alpha invoice links required');
  assertHistoricalInvoicesComplete(historical,links);
  const globalBlockers=[
    'Fresh complete provider and Xero readiness evidence required',
    'Independently reviewed scheduled-release migration and runtime adapter required',
    'Matching active deployed worker/accounting source proof required',
  ];
  try{validateAlphaBankApproval(handover,adoptions.map(a=>a.member_id),new Date(completedAt));}
  catch{globalBlockers.push('Fresh exact-alpha accounting destination approval required');}
  try{validateAlphaHandover(handover,adoptions.map(a=>a.member_id),new Date(completedAt));}
  catch(error){globalBlockers.push(error.message);}
  const members=adoptions.map(a=>{
    const m=manifest.members.find(m=>m.identity.memberId===a.member_id);
    const rows=canonical.filter(r=>r.adoption_id===a.id),blockers=[];
    if(rows.length!==1)fail('Canonical alpha identity missing/ambiguous');
    const {plan:p,agreement:b,history:h,member}=rows[0];
    for(const r of [p,b,h,member]){
      if(!r||r.tenant_id!==TENANT_ID||(r===member?r.id:r.member_id)!==a.member_id)
        fail('Cross-tenant/member alpha canonical identity');
    }
    if(p.id!==a.plan_id||b.id!==a.agreement_id||h.id!==a.history_id
      ||p.billing_agreement_id!==b.id||h.billing_agreement_id!==b.id
      ||p.gocardless_mandate_id!==a.mandate_id||b.gocardless_mandate_id!==a.mandate_id
      ||b.gocardless_customer_id!==a.customer_id||p.environment!=='live'||b.environment!=='live'
      ||p.provider!=='gocardless'||b.provider!=='gocardless'||!same(b.metadata?.dd,m.dd))
      fail('Alpha canonical ownership or immutable consent drift');
    if(!p.collection_stopped_at||p.metadata?.bnms_release_required!==true||p.metadata?.bnms_alpha_held!==true
      ||p.status!=='first_payment_pending'||b.status!=='first_payment_pending'
      ||h.status!=='pending_payment_setup'||h.payment_status!=='unpaid'
      ||p.gocardless_subscription_id||p.dynamic_next_collection_date!=='2026-10-01')
      blockers.push('Canonical alpha hold/state drift');
    const stored=historical.filter(r=>r.adoption_id===a.id);
    if(stored.length!==m.history.length||stored.some(r=>r.member_id!==a.member_id||r.tenant_id!==TENANT_ID
      ||!m.history.some(e=>e.id===r.id&&same(e.evidence,r.evidence))))
      fail('Immutable alpha historical provider evidence drift');
    const invoiceLinks=links.filter(r=>r.member_id===a.member_id);
    if(!same([...invoiceLinks].sort((a,b)=>a.history_id.localeCompare(b.history_id)),
      [...m.links].sort((a,b)=>a.history_id.localeCompare(b.history_id))))fail('Immutable alpha Xero links drift');
    return {memberId:a.member_id,adoptionId:a.id,planId:a.plan_id,mandateId:a.mandate_id,
      customerId:a.customer_id,held:!blockers.length,blockers};
  });
  return {version:1,mode:'alpha_release_preparation_only',tenantId:TENANT_ID,
    manifestSha256:ALPHA_MANIFEST_SHA256,observedAt,completedAt,
    processingNotBefore:PROCESSING_NOT_BEFORE,providerChargeDate:'Fresh provider date; existing seven-day safety window',
    members,excludedExceptions:170,historicalInvoiceCount:2137,globalBlockers,
    releasable:false,writes:0,providerWrites:0};
}

// Bounded staging stops rather than hiding 429s or resetting the freshness clock.
// Callers persist checkpoints privately; a completed earlier stage can only be
// reused while its original timestamps still satisfy assertAlphaStageFresh.
export async function readAlphaStage(memberIds,readMember,{now=()=>new Date(),maxMembers=25}={}){
  if(!Number.isInteger(maxMembers)||maxMembers<1||maxMembers>25
    ||!memberIds.length||memberIds.length>maxMembers||new Set(memberIds).size!==memberIds.length)
    fail('A stage requires 1–25 unique members');
  const observedAt=now().toISOString(),evidence=[];
  for(const memberId of memberIds){
    if(now().getTime()-Date.parse(observedAt)>MAX_EVIDENCE_AGE_MS)
      return {manifestSha256:ALPHA_MANIFEST_SHA256,memberIds,observedAt,completedAt:now().toISOString(),
        complete:false,evidence,blocker:'Evidence budget exhausted; refresh oldest stage'};
    try{evidence.push({memberId,evidence:await readMember(memberId)});}
    catch(error){
      return {manifestSha256:ALPHA_MANIFEST_SHA256,memberIds,observedAt,completedAt:now().toISOString(),
        complete:false,evidence,blocker:error?.status===429?'Provider rate limit; resume only with fresh evidence':'Provider evidence read failed'};
    }
  }
  const completedAt=now().toISOString();
  return {manifestSha256:ALPHA_MANIFEST_SHA256,memberIds,observedAt,completedAt,
    complete:Date.parse(completedAt)-Date.parse(observedAt)<=MAX_EVIDENCE_AGE_MS,evidence};
}

const sorted=items=>[...items].sort((a,b)=>String(a.id||a.history_id).localeCompare(String(b.id||b.history_id)));
const withoutAudit=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['updated_at','created_at'].includes(key)));
export const alphaStateHash=state=>hash(Object.fromEntries(Object.entries(state).map(([key,rows])=>[key,sorted(rows).map(withoutAudit)])));
const chunks=(rows,size)=>Array.from({length:Math.ceil(rows.length/size)},(_,i)=>rows.slice(i*size,(i+1)*size));
const checked=async(query,label)=>{const result=await query;if(result.error)fail(`${label}: database read failed (${result.error.code})`);return result.data;};
async function rows(db,table,filter=q=>q,order='id'){
  const result=[];
  for(let offset=0;offset<10000;offset+=500){
    const page=await checked(filter(db.from(table).select('*')).order(order).range(offset,offset+499),table);
    result.push(...page);if(page.length<500)return result;
  }
  fail(`${table}: pagination budget exceeded`);
}
async function ownedRows(db,table,ids,column='member_id'){
  const result=[];
  for(const group of chunks(ids,50))
    result.push(...await rows(db,table,q=>q.eq('tenant_id',TENANT_ID).in(column,group)));
  return result;
}

// No automatic retries: a 429 or incomplete page invalidates this scan. The
// oldest timestamp is retained through pacing, all reads, review and locking.
export function boundedAlphaTransport({transport=fetch,now=()=>new Date(),observedAt,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxRequests=1200}={}){
  let requests=0;
  const previous={};
  return async(url,options={})=>{
    const target=new URL(url);
    if(options.method!=='GET'||!['api.xero.com','api.gocardless.com'].includes(target.hostname)
      ||target.protocol!=='https:'||target.username||target.password)
      fail('Alpha readiness permits pinned provider GET requests only');
    if(++requests>maxRequests)fail('Alpha provider request budget exhausted');
    const gap=target.hostname==='api.xero.com'?1250:220;
    const wait=Math.max(0,(previous[target.hostname]||0)+gap-now().getTime());
    if(wait)await sleep(wait);
    const remaining=MAX_EVIDENCE_AGE_MS-(now().getTime()-Date.parse(observedAt));
    if(!Number.isFinite(remaining)||remaining<=0)fail('Oldest alpha readiness evidence exceeded 15 minutes');
    previous[target.hostname]=now().getTime();
    const result=await transport(url,{...options,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(30000,remaining)))});
    if(!result.ok){
      const error=Error(result.status===429?'Provider rate limit: scan stopped; refresh evidence before retry':`Provider GET failed (HTTP ${result.status})`);
      error.status=result.status;throw error;
    }
    return result;
  };
}

export function alphaHistoricalInvoiceUnchanged(link,current){
  const original=link.evidence?.invoice;
  if(!original||!current||current.InvoiceID!==link.xero_invoice_id||current.InvoiceNumber!==link.xero_invoice_number
    ||current.Contact?.ContactID!==link.xero_contact_id||current.Type!=='ACCREC'||current.Status!=='PAID'
    ||current.CurrencyCode!=='GBP'||Number(current.AmountDue)!==0||Number(current.AmountCredited)!==0
    ||!Array.isArray(current.Payments)||!Array.isArray(current.LineItems)
    ||['CreditNotes','Prepayments','Overpayments'].some(key=>!Array.isArray(current[key])||current[key].length))
    return false;
  const financial=invoice=>({
    day:invoice.DateString?.slice(0,10),total:Number(invoice.Total),paid:Number(invoice.AmountPaid),tax:Number(invoice.TotalTax),
    lines:invoice.LineItems?.map(line=>({account:line.AccountCode,taxType:line.TaxType,tax:Number(line.TaxAmount),
      quantity:Number(line.Quantity),unit:Number(line.UnitAmount),amount:Number(line.LineAmount)})),
    payments:invoice.Payments?.map(p=>({id:p.PaymentID,amount:Number(p.Amount),reference:p.Reference}))
      .sort((a,b)=>String(a.id).localeCompare(String(b.id))),
  });
  const now=financial(current),before=financial(original);
  if(!Number.isFinite(now.total)||!Number.isFinite(now.paid)||!Number.isFinite(now.tax)
    ||now.lines.some(line=>![line.tax,line.quantity,line.unit,line.amount].every(Number.isFinite))
    ||now.payments.some(p=>!Number.isFinite(p.amount)))return false;
  return same(now,before)&&current.Payments.some(p=>p.PaymentID===link.xero_payment_id);
}

export function assertAlphaLiveContact(links,contact,memberId){
  const normalize=value=>typeof value==='string'?value.trim().toLowerCase():'';
  if(!links.length||!contact||contact.ContactStatus!=='ACTIVE'||!normalize(contact.EmailAddress)
    ||links.some(link=>link.member_id!==memberId||link.tenant_id!==TENANT_ID
      ||link.xero_tenant_id!==ALPHA_XERO_TENANT_ID||link.xero_contact_id!==contact.ContactID
      ||link.evidence?.contact?.ContactID!==contact.ContactID
      ||normalize(link.evidence.contact.EmailAddress)!==normalize(contact.EmailAddress)))
    fail('Live Xero contact must match active exact immutable alpha owner/email; name is not identity');
  return {contactId:contact.ContactID,status:contact.ContactStatus,email:normalize(contact.EmailAddress)};
}

export async function readAlphaReleaseEvidence(db,{manifest,handover,transport=fetch,now=()=>new Date(),sleep}={}){
  const observedAt=now().toISOString();
  const adoptions=await rows(db,'bnms_dd_alpha_adoption',q=>q.eq('tenant_id',TENANT_ID));
  validateAlphaReleaseScope(manifest,adoptions);
  const ids=adoptions.map(a=>a.member_id);
  validateAlphaBankApproval(handover,ids,now());
  const historical=await rows(db,'bnms_dd_alpha_provider_history',q=>q.eq('tenant_id',TENANT_ID));
  const links=await rows(db,'bnms_dd_alpha_invoice_link',q=>q.eq('tenant_id',TENANT_ID),'history_id');
  const state={};
  for(const table of ['membership_payment_plans','membership_billing_agreements','member_membership_history'])
    state[table]=await ownedRows(db,table,ids);
  state.member=await ownedRows(db,'member',ids,'id');
  state.membership_tier_config=await rows(db,'membership_tier_config',q=>q.eq('tenant_id',TENANT_ID));
  state.membership_tier_vat_override=await rows(db,'membership_tier_vat_override',q=>q.eq('tenant_id',TENANT_ID));
  state.preference_field=await rows(db,'preference_field',q=>q.eq('tenant_id',TENANT_ID).eq('name','member_class').eq('entity_scope','member').eq('is_active',true));
  if(state.preference_field.length!==1)fail('Member class field missing or ambiguous');
  state.member_preference_value=[];
  for(const group of chunks(ids,50))
    state.member_preference_value.push(...await rows(db,'member_preference_value',q=>q.in('member_id',group)));
  const canonical=adoptions.map(a=>({adoption_id:a.id,
    plan:state.membership_payment_plans.find(r=>r.id===a.plan_id),
    agreement:state.membership_billing_agreements.find(r=>r.id===a.agreement_id),
    history:state.member_membership_history.find(r=>r.id===a.history_id),
    member:state.member.find(r=>r.id===a.member_id)}));
  const held=prepareAlphaRelease({manifest,adoptions,historical,links,canonical,handover,observedAt,completedAt:now().toISOString()});
  const settings=await rows(db,'system_settings',q=>q.eq('tenant_id',TENANT_ID).in('setting_key',
    ['xero_gocardless_bank_account_code','membership_nominal_ledger','xero_sales_account_code']));
  const provider=await checked(db.from('tenant_accounting_settings').select('active_provider').eq('tenant_id',TENANT_ID).maybeSingle(),'accounting provider');
  const tokens=await checked(db.from('xero_token').select('tenant_id,access_token,expires_at').eq('app_tenant_id',TENANT_ID),'Xero authentication');
  if(tokens.length!==1||tokens[0].tenant_id!==ALPHA_XERO_TENANT_ID
    ||!Number.isFinite(Date.parse(tokens[0].expires_at))
    ||Date.parse(tokens[0].expires_at)<now().getTime()+MAX_EVIDENCE_AGE_MS)
    fail('Pinned Xero credential must remain valid for full readiness budget; refresh separately');
  const safeTransport=boundedAlphaTransport({transport,now,observedAt,sleep});
  const xero=async(resource,query={})=>{
    const url=new URL(`https://api.xero.com/api.xro/2.0/${resource}`);
    for(const [key,value]of Object.entries(query))url.searchParams.set(key,value);
    const response=await safeTransport(url,{method:'GET',headers:{Authorization:`Bearer ${tokens[0].access_token}`,
      'Xero-tenant-id':ALPHA_XERO_TENANT_ID,Accept:'application/json'}});
    return response.json();
  };
  const accounts=(await xero('Accounts')).Accounts;
  if(!Array.isArray(accounts))fail('Complete Xero account evidence required');
  const banks=accounts.filter(a=>a.AccountID===ALPHA_BANK_ACCOUNT_ID&&a.Type==='BANK'&&a.Status==='ACTIVE'&&a.CurrencyCode==='GBP');
  const globalBlockers=[];
  if(provider?.active_provider!=='xero')globalBlockers.push('Dedicated Xero accounting provider must be configured');
  if(banks.length!==1)globalBlockers.push('Approved GoCardless-GBP must resolve to pinned ACTIVE GBP BANK');
  // Account-wide paginated discovery prevents a second mandate being hidden by
  // per-mandate filters and costs far fewer requests than 249 x five GETs.
  const {alphaProviderReader}=await import('./bnms-dd-alpha-review.mjs');
  const {readAllProviderPages}=await import('./bnms-dd-pilot.mjs');
  const {getTenantGocardlessCredentials}=await import('../api/_lib/gocardlessCredentials.js');
  const {resolveDynamicCollectionPrice}=await import('../api/_lib/gocardlessDynamicCollections.js');
  const {alphaAccountingMapping}=await import('../api/_lib/bnmsAlphaAccounting.js');
  const get=alphaProviderReader(await getTenantGocardlessCredentials(TENANT_ID,{db}),safeTransport);
  const discovery={};
  for(const resource of ['mandates','customers','subscriptions','payments']){
    discovery[resource]=await readAllProviderPages(get,resource);
    if(discovery[resource].some(r=>!r.id)||new Set(discovery[resource].map(r=>r.id)).size!==discovery[resource].length)
      fail(`Duplicate/missing provider ${resource} identity`);
  }
  // Xero accepts ContactIDs as an explicit filter. Bound URL size and request
  // cadence, verify every returned owner, and exhaust all pages before use.
  const contactIds=[...new Set(links.map(l=>l.xero_contact_id))],invoicesByContact=new Map(),liveContacts=new Map();
  for(const contactId of contactIds){
    const owned=links.filter(link=>link.xero_contact_id===contactId);
    const owners=[...new Set(owned.map(link=>link.member_id))];
    if(owners.length!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(contactId))
      fail('Historical Xero contact is shared or has invalid immutable identity');
    // An exact authenticated GET is required even if invoices still show the
    // historical ID. Contact names never authorize matching or creation.
    const contacts=(await xero(`Contacts/${contactId}`)).Contacts;
    if(!Array.isArray(contacts)||contacts.length!==1)
      fail('Exact live Xero contact response missing or ambiguous');
    liveContacts.set(contactId,assertAlphaLiveContact(owned,contacts[0],owners[0]));
  }
  for(const contactGroup of chunks(contactIds,25)){
    const seen=new Set();let complete=false;
    for(let page=1;page<=100;page++){
      const invoices=(await xero('Invoices',{ContactIDs:contactGroup.join(','),page:String(page)})).Invoices;
      if(!Array.isArray(invoices))fail('Xero invoice pagination incomplete');
      for(const invoice of invoices){
        const contact=invoice.Contact?.ContactID;
        if(!contactGroup.includes(contact)||!invoice.InvoiceID||seen.has(invoice.InvoiceID)
          ||!/^\d{4}-\d{2}-\d{2}/.test(invoice.DateString||'')||typeof invoice.Status!=='string'
          ||invoice.AmountDue===null||invoice.AmountDue===undefined||!Number.isFinite(Number(invoice.AmountDue))||Number(invoice.AmountDue)<0)
          fail('Xero invoice owner/date/pagination mismatch');
        seen.add(invoice.InvoiceID);
        if(!invoicesByContact.has(contact))invoicesByContact.set(contact,[]);
        invoicesByContact.get(contact).push(invoice);
      }
      if(invoices.length<100){complete=true;break;}
    }
    if(!complete)fail('Xero invoice page budget exhausted');
  }
  const reservations=await ownedRows(db,'gocardless_collection_reservations',adoptions.map(a=>a.plan_id),'plan_id');
  const payments=await ownedRows(db,'gocardless_payments',adoptions.map(a=>a.mandate_id),'gocardless_mandate_id');
  const members=[];
  for(const a of adoptions){
    const blockers=[...held.members.find(m=>m.memberId===a.member_id).blockers];
    const member=state.member.find(m=>m.id===a.member_id);
    const agreement=state.membership_billing_agreements.find(r=>r.id===a.agreement_id);
    if(member.is_deleted||member.deleted_at||member.membership_paused||['deleted','cancelled','paused'].includes(member.status))
      blockers.push('Member unavailable');
    for(const table of ['membership_payment_plans','membership_billing_agreements','member_membership_history'])
      if(state[table].filter(r=>r.member_id===a.member_id).length!==1)blockers.push('Additional canonical records require reconciliation');
    const preferences=state.member_preference_value.filter(r=>r.member_id===a.member_id&&r.field_id===state.preference_field[0].id);
    if(preferences.length!==1||preferences[0].value!==a.evidence.structure.structure_match_value)
      blockers.push('Current member class differs from imported scope');
    if(reservations.some(r=>r.plan_id===a.plan_id)||payments.some(p=>p.gocardless_mandate_id===a.mandate_id))
      blockers.push('Canonical payment/reservation already exists');
    let price=null;
    try{price=await resolveDynamicCollectionPrice(agreement,'2026-10-01',{db});}
    catch{blockers.push('Current consent-aware dynamic price unavailable');}
    if(price?.monthly_amount_minor!==a.evidence.monthlyQuoteMinor)
      blockers.push('First scheduled alpha price differs from pinned import quote; separate review required');
    const revenueCode=String(price?.nominal_code||settings.find(s=>s.setting_key==='membership_nominal_ledger')?.setting_value
      ||settings.find(s=>s.setting_key==='xero_sales_account_code')?.setting_value||'');
    if(!revenueCode||accounts.filter(x=>x.Code===revenueCode&&x.Status==='ACTIVE'&&x.Type==='REVENUE').length!==1)
      blockers.push('Explicit active Xero REVENUE account required');
    let mapping=null;
    const approvedRevenue={Full:'200','Full with NMC':'200','Full junior':'201','Full junior with NMC':'201'}[a.evidence.structure.structure_match_value];
    if(revenueCode!==approvedRevenue)blockers.push('Current revenue account differs from adopted member-class accounting');
    try{mapping=alphaAccountingMapping(revenueCode);}catch{blockers.push('Unsupported alpha revenue mapping');}
    const mandate=discovery.mandates.find(m=>m.id===a.mandate_id),customer=discovery.customers.find(c=>c.id===a.customer_id);
    const mandates=discovery.mandates.filter(m=>m.links?.customer===a.customer_id);
    const subscriptions=discovery.subscriptions.filter(s=>s.links?.mandate===a.mandate_id);
    const providerPayments=discovery.payments.filter(p=>p.links?.mandate===a.mandate_id);
    if(mandates.length!==1||mandate?.status!=='active'||mandate.links?.customer!==a.customer_id
      ||mandate.links?.creditor!=='CR0000B50W1Y2R'||!customer
      ||!/^\d{4}-\d{2}-\d{2}$/.test(mandate?.next_possible_charge_date||'')
      ||mandate.next_possible_charge_date>'2026-10-08')blockers.push('Provider mandate/owner/earliest-date conflict');
    if(subscriptions.length)blockers.push('External subscriptions exist');
    const stored=historical.filter(h=>h.member_id===a.member_id);
    const windowPayments=providerPayments.filter(p=>p.charge_date>='2026-01-01');
    if(windowPayments.length!==stored.length||providerPayments.some(p=>['pending_submission','submitted','confirmed'].includes(p.status)||p.charge_date>='2026-10-01')
      ||windowPayments.some(p=>p.status!=='paid_out'||p.amount_refunded!==0
      ||!stored.some(h=>h.provider_payment_id===p.id&&h.amount_minor===p.amount&&h.currency===p.currency&&h.charge_date===p.charge_date)))
      blockers.push('Provider payment history/future schedule requires reconciliation');
    const contacts=[...new Set(links.filter(l=>l.member_id===a.member_id).map(l=>l.xero_contact_id))];
    if(contacts.length!==1)blockers.push('Historical Xero contact ownership ambiguous');
    const currentInvoices=invoicesByContact.get(contacts[0])||[];
    if(links.filter(l=>l.member_id===a.member_id).some(link=>
      !alphaHistoricalInvoiceUnchanged(link,currentInvoices.find(invoice=>invoice.InvoiceID===link.xero_invoice_id))))
      blockers.push('Current historical Xero invoice/payment financial evidence differs from immutable links');
    const futureInvoices=currentInvoices.filter(i=>!['VOIDED','DELETED'].includes(i.Status)
      &&(i.DateString.slice(0,10)>='2026-10-01'||Number(i.AmountDue)>0))
      .map(i=>({id:i.InvoiceID,date:i.DateString,status:i.Status}));
    if(futureInvoices.length)blockers.push('Future/outstanding Xero invoices require reconciliation');
    members.push({adoptionId:a.id,memberId:a.member_id,planId:a.plan_id,agreementId:a.agreement_id,historyId:a.history_id,
      mandateId:a.mandate_id,customerId:a.customer_id,adoptionHash:hash(withoutAudit(a)),price,blockers,
      provider:{mandate,customer,subscriptions,payments:providerPayments,mandateCount:mandates.length},futureInvoices,
      accounting:{xeroTenantId:ALPHA_XERO_TENANT_ID,bankAccountId:banks[0]?.AccountID||null,
        bankCode:banks[0]?.Code||null,revenueCode,contactId:contacts[0]||null,
        contact:liveContacts.get(contacts[0])||null,mapping},historicalInvoiceCount:stored.length});
  }
  const completedAt=now().toISOString();
  if(Date.parse(completedAt)-Date.parse(observedAt)>MAX_EVIDENCE_AGE_MS)globalBlockers.push('Oldest readiness evidence exceeds 15 minutes');
  return {version:1,tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,manifest,observedAt,completedAt,
    state,stateHash:alphaStateHash(state),historicalHash:hash({historical:sorted(historical),links:sorted(links)}),
    members,settings,provider,handover,globalBlockers};
}

export function assertAlphaEvidenceFresh(report,instant=new Date()){
  assertAlphaStageFresh([{manifestSha256:report.manifestSha256,memberIds:report.members.map(m=>m.memberId),
    observedAt:report.observedAt,completedAt:report.completedAt,complete:true}],report.members.map(m=>m.memberId),instant);
  validateAlphaBankApproval(report.handover,report.members.map(m=>m.memberId),instant);
}

export async function alphaReleaseManifest(report,proof){
  if(report?.tenantId!==TENANT_ID||report.manifestSha256!==ALPHA_MANIFEST_SHA256
    ||hash(report.manifest)!==ALPHA_MANIFEST_SHA256||report.members?.length!==249
    ||new Set(report.members.map(m=>m.memberId)).size!==249)
    fail('Exact immutable 249-member alpha readiness required');
  if(!Array.isArray(report.globalBlockers)||report.globalBlockers.length
    ||report.members.some(m=>!Array.isArray(m.blockers)||m.blockers.length))
    fail('Unresolved alpha readiness evidence');
  if(!proof?.sourceHashes?.['api/_lib/bnmsAlphaAccounting.js']||!proof.deploymentId||!proof.commit)
    fail('Verified active alpha deployment proof required');
  const {alphaAccountingMapping}=await import('../api/_lib/bnmsAlphaAccounting.js');
  for(const m of report.members){
    const saved=report.manifest.members.find(s=>s.identity.memberId===m.memberId);
    if(!saved||saved.ids.adoption!==m.adoptionId||saved.ids.plan!==m.planId||saved.ids.agreement!==m.agreementId
      ||saved.ids.membership!==m.historyId||saved.identity.mandateId!==m.mandateId||saved.identity.customerId!==m.customerId
      ||!m.price||m.price.currency!=='GBP'||!Number.isInteger(m.price.monthly_amount_minor)||m.price.monthly_amount_minor<=0)
      fail('Alpha readiness owner/price differs from immutable scope');
    const revenue={Full:'200','Full with NMC':'200','Full junior':'201','Full junior with NMC':'201'}[saved.structure.structure_match_value];
    if(!same(m.accounting?.mapping,alphaAccountingMapping(revenue))
      ||m.accounting.bankAccountId!==ALPHA_BANK_ACCOUNT_ID||m.accounting.xeroTenantId!==ALPHA_XERO_TENANT_ID
      ||m.accounting.revenueCode!==revenue)fail('Approved alpha accounting mapping mismatch');
    const contact=m.accounting.contact;
    if(!contact||contact.contactId!==m.accounting.contactId)fail('Exact live alpha Xero contact evidence required');
    assertAlphaLiveContact(saved.links,{ContactID:contact.contactId,ContactStatus:contact.status,EmailAddress:contact.email},m.memberId);
  }
  // Freshness is checked separately after exact journal replay detection. A
  // replay acknowledges past arming; it does not renew expired authorization.
  return {version:1,tenantId:TENANT_ID,manifestSha256:ALPHA_MANIFEST_SHA256,
    processingNotBefore:PROCESSING_NOT_BEFORE,stateHash:report.stateHash,historicalHash:report.historicalHash,
    production:proof,handover:report.handover,members:report.members.map(m=>({
      adoptionId:m.adoptionId,memberId:m.memberId,planId:m.planId,agreementId:m.agreementId,historyId:m.historyId,
      mandateId:m.mandateId,customerId:m.customerId,adoptionHash:m.adoptionHash,price:m.price,accounting:m.accounting,
      processingNotBefore:PROCESSING_NOT_BEFORE,providerEarliestDate:m.provider.mandate.next_possible_charge_date,
      historicalInvoiceCount:m.historicalInvoiceCount}))};
}

export async function verifyAlphaInvoiceSchema(c){
  const text=await readFile(INVOICE_MIGRATION,'utf8');
  if(sqlHash(text)!==INVOICE_MIGRATION_SHA256)fail('Reviewed alpha invoice-operation source differs');
  const ready=(await c.query("SELECT to_regclass('public.bnms_alpha_invoice_operations') IS NOT NULL AS ready")).rows[0]?.ready;
  if(!ready)fail('Mandatory alpha invoice-operation schema missing');
  const signatures={
    bnms_alpha_claim_invoice:'uuid,uuid,text,jsonb',
    bnms_alpha_link_invoice:'uuid,uuid,text',
    bnms_alpha_assert_invoice:'uuid,uuid,text,text,text',
  };
  const functions=(await c.query(`SELECT p.oid,p.proname,p.prosrc,p.prosecdef,p.proconfig,p.provolatile,
    p.prokind,p.proretset,p.proleakproof,p.proparallel,p.pronargdefaults,p.proargnames,
    p.proisstrict,p.provariadic,p.proargmodes,
    pg_get_userbyid(p.proowner) AS owner,n.nspname,l.lanname,p.prorettype='jsonb'::regtype AS returns_jsonb,
    NOT EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND NOT(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role')
        AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) AS safe_acl,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.proname=ANY($1)`,[Object.keys(signatures)])).rows;
  if(functions.length!==3)fail('Alpha invoice operation function/overload set differs');
  for(const [name,args]of Object.entries(signatures)){
    const source=text.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)\\)\\s*RETURNS jsonb[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`));
    if(!source)fail('Canonical alpha invoice function source missing');
    const expectedArgs=source[1].split(',').map(arg=>arg.trim().split(/\s+/)[0]);
    const expectedOid=(await c.query('SELECT to_regprocedure($1)::oid AS oid',[`public.${name}(${args})`])).rows[0]?.oid;
    const row=functions.find(fn=>fn.proname===name);
    if(!row||row.oid!==expectedOid||row.prosrc!==source[2]||!row.prosecdef
      ||!same(row.proconfig,['search_path=public, pg_temp'])||row.owner!=='postgres'
      ||row.lanname!=='plpgsql'||!row.returns_jsonb||row.provolatile!=='v'||row.prokind!=='f'
      ||row.proretset||row.proleakproof||row.proparallel!=='u'||row.pronargdefaults!==0
      ||row.proisstrict||row.provariadic!==0||row.proargmodes!==null
      ||!same(row.proargnames,expectedArgs)||!row.safe_acl||!row.service_execute)
      fail(`Alpha invoice function signature/body/security differs: ${name}`);
  }
  const table=(await c.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,c.relkind,pg_get_userbyid(c.relowner) AS owner,
    NOT EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND NOT(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role')
        AND a.privilege_type='SELECT' AND NOT a.is_grantable)) AS safe_acl,
    has_table_privilege('service_role',c.oid,'SELECT') AS service_read,
    NOT EXISTS(SELECT FROM pg_policy WHERE polrelid=c.oid) AS no_policies,
    NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal) AS no_triggers
    FROM pg_class c WHERE c.oid='public.bnms_alpha_invoice_operations'::regclass`)).rows[0];
  if(!table?.relrowsecurity||table.relforcerowsecurity||table.relkind!=='r'||table.owner!=='postgres'
    ||!table.safe_acl||!table.service_read||!table.no_policies||!table.no_triggers)
    fail('Alpha invoice operation table owner/RLS/privileges/triggers differ');
  const columns=(await c.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attacl,
    a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.bnms_alpha_invoice_operations'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  const spec={
    id:['uuid',true,'gen_random_uuid()'],tenant_id:['uuid',true,null],plan_id:['uuid',true,null],
    payment_id:['text',true,null],request_identity:['jsonb',true,null],claim_token:['uuid',true,'gen_random_uuid()'],
    invoice_id:['text',false,null],created_at:['timestamp with time zone',true,'clock_timestamp()'],
    linked_at:['timestamp with time zone',false,null],
  };
  if(columns.length!==9||columns.some(row=>!spec[row.attname]
    ||!same([row.type,row.attnotnull,row.default_value],spec[row.attname])
    ||row.attacl!==null||row.attidentity!==''||row.attgenerated!==''))
    fail('Alpha invoice operation column/claim defaults or privileges differ');
  const constraints=(await c.query(`SELECT k.contype,k.convalidated,k.condeferrable,k.condeferred,
    pg_get_constraintdef(k.oid) AS definition,k.confrelid::regclass::text AS referenced_table,
    k.confupdtype,k.confdeltype,k.confmatchtype,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS referenced_columns,
    CASE WHEN k.contype IN ('p','u') THEN (SELECT i.indisvalid AND i.indisready AND i.indisunique
      AND i.indpred IS NULL AND i.indexprs IS NULL FROM pg_index i WHERE i.indexrelid=k.conindid) ELSE true END AS valid_index
    FROM pg_constraint k WHERE k.conrelid='public.bnms_alpha_invoice_operations'::regclass`)).rows;
  const keys=new Set(['p:id','u:payment_id','u:invoice_id']);
  let check=false,fk=false;
  if(constraints.length!==5)fail('Alpha invoice operation constraint set differs');
  for(const row of constraints){
    if(!row.convalidated||row.condeferrable||row.condeferred||!row.valid_index)
      fail('Alpha invoice operation constraints/indexes must be immediate and valid');
    if(row.contype==='p'||row.contype==='u'){
      if(!keys.delete(`${row.contype}:${row.columns.join(',')}`))fail('Alpha invoice operation unique identity differs');
    }else if(row.contype==='c'&&!check&&row.definition==='CHECK (((invoice_id IS NULL) = (linked_at IS NULL)))')check=true;
    else if(row.contype==='f'&&!fk&&same(row.columns,['plan_id'])&&same(row.referenced_columns,['id'])
      &&row.referenced_table.replace(/^public\./,'')==='membership_payment_plans'
      &&row.confupdtype==='a'&&row.confdeltype==='a'&&row.confmatchtype==='s')fk=true;
    else fail('Alpha invoice operation check/foreign-key binding differs');
  }
  if(keys.size||!check||!fk)fail('Alpha invoice operation constraints incomplete');
}

export async function verifyAlphaReleaseSchema(c){
  await verifyAlphaInvoiceSchema(c);
  const sources=await Promise.all([
    readFile(new URL('../supabase/migrations/20261108_bnms_dd_pilot_history.sql',import.meta.url),'utf8'),
    readFile(new URL('../supabase/migrations/20261113_bnms_dd_alpha_held.sql',import.meta.url),'utf8'),
    readFile(MIGRATION,'utf8'),
  ]);
  const functions=new Map(),triggers=new Map();
  for(const text of sources){
    for(const match of text.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(\) RETURNS trigger[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)){
      if(match[1].startsWith('bnms_dd_alpha_')||match[1]==='bnms_dd_reject_history_mutation')
        functions.set(match[1],{body:match[2],config:/SET search_path\s*=\s*public/i.test(match[0])?['search_path=public']:null});
    }
    // Later migration replaces bindings explicitly. Constraint triggers retain
    // their deferral semantics; disabled or narrowed UPDATE OF triggers fail.
    for(const statement of text.split(';')){
      const drop=statement.match(/DROP TRIGGER (?:IF EXISTS )?(\w+) ON (?:public\.)?(\w+)/i);
      if(drop)triggers.delete(`${drop[2]}.${drop[1]}`);
      const m=statement.match(/CREATE (CONSTRAINT )?TRIGGER (\w+) (BEFORE|AFTER) ([A-Z ]+) ON public\.(\w+)\s+(DEFERRABLE INITIALLY DEFERRED\s+)?FOR EACH ROW EXECUTE FUNCTION public\.(\w+)\(\)/);
      if(m&&(m[2].includes('alpha')||m[5].includes('alpha'))){
        const type=1+(m[3]==='BEFORE'?2:0)+(m[4].includes('INSERT')?4:0)+(m[4].includes('DELETE')?8:0)+(m[4].includes('UPDATE')?16:0);
        triggers.set(`${m[5]}.${m[2]}`,{name:m[2],table:m[5],fn:m[7],type,constraint:!!m[1],deferred:!!m[6]});
      }
    }
  }
  for(const table of ['bnms_dd_alpha_adoption','bnms_dd_alpha_provider_history','bnms_dd_alpha_invoice_link'])
    triggers.set(`${table}.alpha_immutable`,{name:'alpha_immutable',table,fn:'bnms_dd_reject_history_mutation',type:27,constraint:false,deferred:false});
  if(functions.size<3||!triggers.size)fail('Canonical alpha schema source incomplete');
  for(const [name,expected]of functions){
    const r=(await c.query(`SELECT p.oid,p.prosrc,p.prosecdef,p.proconfig,p.provolatile,n.nspname,l.lanname,
      p.prorettype='trigger'::regtype AS returns_trigger,pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure($1)`,[`public.${name}()`])).rows[0];
    if(!r||r.prosrc!==expected.body||r.prosecdef||!same(r.proconfig,expected.config)
      ||r.nspname!=='public'||r.lanname!=='plpgsql'||!r.returns_trigger||r.provolatile!=='v'||r.owner!=='postgres')
      fail(`Installed alpha function/security differs: ${name}`);
    expected.oid=r.oid;
  }
  const installed=(await c.query(`SELECT t.tgname,t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,t.tgconstraint,
    t.tgdeferrable,t.tginitdeferred,t.tgattr::text AS columns,t.tgqual,encode(t.tgargs,'hex') AS args,
    n.nspname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
    AND (t.tgname LIKE '%alpha%' OR c.relname='bnms_dd_alpha_release')`)).rows;
  if(installed.length!==triggers.size)fail('Alpha trigger set differs');
  for(const t of installed){
    const expected=triggers.get(`${t.relname}.${t.tgname}`);
    if(!expected||t.nspname!=='public'||t.tgfoid!==functions.get(expected.fn)?.oid||t.tgtype!==expected.type
      ||!['O','A'].includes(t.tgenabled)||Boolean(t.tgconstraint)!==expected.constraint
      ||t.tgdeferrable!==expected.deferred||t.tginitdeferred!==expected.deferred
      ||t.columns!==''||t.tgqual!==null||t.args!=='')fail(`Alpha trigger binding/security differs: ${t.tgname}`);
  }
  const access=(await c.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,c.relkind,pg_get_userbyid(c.relowner) AS owner,
    NOT EXISTS(SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND NOT(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role')
        AND a.privilege_type='SELECT' AND NOT a.is_grantable)) AS safe_acl,
    has_table_privilege('service_role',c.oid,'SELECT') AS service_read,
    NOT EXISTS(SELECT FROM pg_policy WHERE polrelid=c.oid) AS no_policies
    FROM pg_class c WHERE c.oid=ANY(ARRAY['public.bnms_dd_alpha_release'::regclass,
      'public.bnms_dd_alpha_adoption'::regclass,'public.bnms_dd_alpha_provider_history'::regclass,
      'public.bnms_dd_alpha_invoice_link'::regclass])`)).rows;
  if(access.length!==4||access.some(table=>!table.relrowsecurity||table.relforcerowsecurity
    ||table.relkind!=='r'||table.owner!=='postgres'||!table.safe_acl||!table.service_read||!table.no_policies))
    fail('Alpha journal/evidence RLS/privileges/owner differ');
  const columns=(await c.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.bnms_dd_alpha_release'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows;
  const spec={id:'uuid',adoption_id:'uuid',tenant_id:'uuid',member_id:'uuid',plan_id:'uuid',
    evidence_sha256:'text',evidence:'jsonb',processing_not_before:'timestamp with time zone',created_at:'timestamp with time zone'};
  if(columns.length!==9||columns.some(a=>spec[a.attname]!==a.type||!a.attnotnull
    ||(a.attname==='id'?a.default_value!=='gen_random_uuid()':a.attname==='created_at'?a.default_value!=='now()':
      a.attname==='processing_not_before'?!/^'2026-09-30 23:00:00\+00'::timestamp with time zone$/.test(a.default_value):a.default_value!==null)))
    fail('Alpha journal columns/defaults differ (UTC required)');
  const constraints=(await c.query(`SELECT k.contype,k.convalidated,k.condeferrable,k.condeferred,
    pg_get_constraintdef(k.oid) AS definition,k.confrelid::regclass::text AS referenced_table,k.confupdtype,k.confdeltype,k.confmatchtype,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS referenced_columns
    FROM pg_constraint k WHERE k.conrelid='public.bnms_dd_alpha_release'::regclass`)).rows;
  const checks=new Set([`CHECK ((tenant_id = '${TENANT_ID}'::uuid))`,
    "CHECK ((evidence_sha256 ~ '^[a-f0-9]{64}$'::text))",
    "CHECK ((processing_not_before = '2026-09-30 23:00:00+00'::timestamp with time zone))"]);
  const keys=new Set(['p:id','u:adoption_id','u:member_id','u:plan_id']);
  const fks=new Set(['plan_id:membership_payment_plans:id','adoption_id,tenant_id,member_id:bnms_dd_alpha_adoption:id,tenant_id,member_id']);
  if(constraints.length!==9)fail('Alpha journal constraint set differs');
  for(const k of constraints){
    if(!k.convalidated||k.condeferrable||k.condeferred)fail('Alpha constraints must be validated and immediate');
    if(k.contype==='c'){if(!checks.delete(k.definition))fail('Alpha journal CHECK differs');}
    else if(k.contype==='p'||k.contype==='u'){if(!keys.delete(`${k.contype}:${k.columns.join(',')}`))fail('Alpha journal owner key differs');}
    else if(k.contype==='f'){
      if(k.confupdtype!=='a'||k.confdeltype!=='a'||k.confmatchtype!=='s'
        ||!fks.delete(`${k.columns.join(',')}:${k.referenced_table.replace(/^public\./,'')}:${k.referenced_columns.join(',')}`))
        fail('Alpha journal foreign-key owner link differs');
    }else fail('Unexpected alpha journal constraint');
  }
  if(checks.size||keys.size||fks.size)fail('Alpha journal constraints incomplete');
}

export async function releaseAlpha(c,report,proof,{apply=false,reviewSha256,verifiedDestination=false,
  now=()=>new Date()}={}){
  const manifest=await alphaReleaseManifest(report,proof),digest=hash(manifest);
  if(apply&&(!verifiedDestination||reviewSha256!==digest))fail('Verified DEST and exact reviewed alpha manifest hash required');
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try{
    await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-alpha-scheduled-release'))");
    const ready=(await c.query("SELECT to_regclass('public.bnms_dd_alpha_release') IS NOT NULL AS ready")).rows[0].ready;
    if(!ready){
      if(apply)fail('Independently reviewed alpha release schema required');
      await c.query('ROLLBACK');return {mode:'schema_required',hash:digest,manifest,writes:0};
    }
    await verifyAlphaReleaseSchema(c);
    const prior=(await c.query('SELECT * FROM bnms_dd_alpha_release WHERE tenant_id=$1',[TENANT_ID])).rows;
    if(prior.length){
      if(prior.length!==249||prior.some(p=>p.evidence_sha256!==digest
        ||!manifest.members.some(m=>m.adoptionId===p.adoption_id&&m.memberId===p.member_id&&m.planId===p.plan_id
          &&same(p.evidence,{...m,production:proof,handover:report.handover,readinessObservedAt:report.observedAt}))))
        fail('Partial/different alpha release requires reconciliation');
      await c.query('ROLLBACK');return {mode:'release_replay',hash:digest,writes:0,readinessRevalidated:false};
    }
    assertAlphaEvidenceFresh(report,now());
    await c.query(`LOCK TABLE member,preference_field,member_preference_value,membership_tier_config,
      membership_billing_agreements,membership_payment_plans,member_membership_history,
      gocardless_collection_reservations,gocardless_payments,system_settings,tenant_accounting_settings,membership_tier_vat_override,
      bnms_dd_alpha_adoption,bnms_dd_alpha_provider_history,bnms_dd_alpha_invoice_link IN SHARE ROW EXCLUSIVE MODE`);
    const ids=manifest.members.map(m=>m.memberId),state={};
    for(const table of ['member','membership_billing_agreements','membership_payment_plans','member_membership_history'])
      state[table]=(await c.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 AND ${table==='member'?'id':'member_id'}=ANY($2::uuid[])`,[TENANT_ID,ids])).rows.map(r=>r.row);
    state.membership_tier_config=(await c.query('SELECT to_jsonb(t) AS row FROM membership_tier_config t WHERE tenant_id=$1',[TENANT_ID])).rows.map(r=>r.row);
    state.preference_field=(await c.query("SELECT to_jsonb(t) AS row FROM preference_field t WHERE tenant_id=$1 AND name='member_class' AND entity_scope='member' AND is_active=true",[TENANT_ID])).rows.map(r=>r.row);
    state.member_preference_value=(await c.query('SELECT to_jsonb(t) AS row FROM member_preference_value t WHERE member_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.row);
    state.membership_tier_vat_override=(await c.query('SELECT to_jsonb(t) AS row FROM membership_tier_vat_override t WHERE tenant_id=$1',[TENANT_ID])).rows.map(r=>r.row);
    if(alphaStateHash(state)!==manifest.stateHash)fail('Canonical/member/price/consent evidence changed since review');
    const settings=(await c.query("SELECT to_jsonb(t) AS row FROM system_settings t WHERE tenant_id=$1 AND setting_key IN ('xero_gocardless_bank_account_code','membership_nominal_ledger','xero_sales_account_code')",[TENANT_ID])).rows.map(r=>r.row);
    const provider=(await c.query('SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1',[TENANT_ID])).rows[0]||null;
    if(!same(sorted(settings).map(withoutAudit),sorted(report.settings).map(withoutAudit))||!same(provider,report.provider))
      fail('Accounting settings changed since review');
    const adoptions=(await c.query('SELECT * FROM bnms_dd_alpha_adoption WHERE tenant_id=$1',[TENANT_ID])).rows;
    validateAlphaReleaseScope(report.manifest,adoptions);
    if(manifest.members.some(m=>hash(withoutAudit(adoptions.find(a=>a.id===m.adoptionId)))!==m.adoptionHash))fail('Adoption identity drift');
    const collisions=(await c.query(`SELECT id FROM gocardless_collection_reservations WHERE plan_id=ANY($1::uuid[]) OR billing_agreement_id=ANY($4::uuid[])
      UNION ALL SELECT id FROM gocardless_payments WHERE tenant_id=$2 AND gocardless_mandate_id=ANY($3::text[])`,
    [manifest.members.map(m=>m.planId),TENANT_ID,manifest.members.map(m=>m.mandateId),manifest.members.map(m=>m.agreementId)])).rows;
    if(collisions.length)fail('Existing canonical payment/reservation requires reconciliation');
    const historical=(await c.query('SELECT to_jsonb(t) AS row FROM bnms_dd_alpha_provider_history t WHERE tenant_id=$1',[TENANT_ID])).rows.map(r=>r.row);
    const links=(await c.query('SELECT to_jsonb(t) AS row FROM bnms_dd_alpha_invoice_link t WHERE tenant_id=$1',[TENANT_ID])).rows.map(r=>r.row);
    if(historical.length!==2137||links.length!==2137
      ||hash({historical:sorted(historical),links:sorted(links)})!==manifest.historicalHash)
      fail('Historical alpha evidence changed');
    assertHistoricalInvoicesComplete(historical,links);
    assertAlphaEvidenceFresh(report,now());
    if(!apply){await c.query('ROLLBACK');return {mode:'scheduled_alpha_release_dry_run',hash:digest,manifest,writes:0};}
    for(const m of manifest.members){
      await c.query(`INSERT INTO bnms_dd_alpha_release(adoption_id,tenant_id,member_id,plan_id,evidence_sha256,evidence)
        VALUES($1,$2,$3,$4,$5,$6)`,[m.adoptionId,TENANT_ID,m.memberId,m.planId,digest,
        {...m,production:proof,handover:report.handover,readinessObservedAt:report.observedAt}]);
      const agreement=await c.query(`UPDATE membership_billing_agreements SET status='first_payment_pending',needs_attention=false,attention_reason=NULL,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND member_id=$3`,[m.agreementId,TENANT_ID,m.memberId]);
      const plan=await c.query(`UPDATE membership_payment_plans SET collection_stopped_at=NULL,metadata=jsonb_set(metadata,'{bnms_release_required}','false'),updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND member_id=$3 AND collection_stopped_at IS NOT NULL`,[m.planId,TENANT_ID,m.memberId]);
      if(agreement.rowCount!==1||plan.rowCount!==1)fail('Concurrent alpha release conflict');
    }
    const dbClock=(await c.query('SELECT clock_timestamp() AS checked_at')).rows[0].checked_at;
    assertAlphaEvidenceFresh(report,new Date(dbClock));
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('COMMIT');
    return {mode:'alpha_armed_for_october_processing',hash:digest,writes:747,providerWrites:0,membershipActivated:false};
  }catch(error){await c.query('ROLLBACK');throw error;}
}